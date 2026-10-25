import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi } from "viem";
import { BLOCK_TIME, CHAIN_ID, isSwapSource, lc, RHC, type Address, type Hex } from "./chain.js";
import { findFunding } from "./funder.js";
import { getLogsChunked, makeRpcs, type GetLogsOptions, type RpcOptions, type Rpcs } from "./rpc.js";
import { runRules, walletLinks, type Finding, type SenderFanout, type TokenMeta, type WalletData } from "./rules.js";
import { trackerCheck } from "./tracker.js";
import { addressTopic, parseTransfers, TRANSFER_TOPIC, walletTransfers } from "./transfers.js";

export const SPEC_VERSION = "zhook-leak-check/1";

/** Default window: 15,000 blocks (~26 min at 0.105 s per block), 15 log calls each way on a 1,000-block RPC. */
export const DEFAULT_BLOCKS = 15_000;
export const MAX_BLOCKS = 500_000;
/** Blocks kept behind head: load-balanced public RPCs return [] for a range past a lagging node's head. */
export const HEAD_LAG = Math.ceil(5 / BLOCK_TIME);
/** Most token senders whose other transfers are read for the shared-funder rule. */
export const MAX_SENDERS = 8;

export interface CheckOptions extends RpcOptions {
  /** Ready-made transports (overrides the RPC options). */
  rpcs?: Rpcs;
  /** Window size in blocks (default 15,000). */
  blocks?: number;
  /** Last block of the window (default: head minus a few seconds). */
  toBlock?: number;
  /** Run the first-funding search on the archive RPC (default true). */
  funding?: boolean;
  /** Run the tracker check (default true). */
  tracker?: boolean;
  logs?: GetLogsOptions;
}

export interface LeakReport {
  spec: typeof SPEC_VERSION;
  chainId: number;
  address: Address;
  kind: WalletData["kind"];
  nonce: number;
  window: {
    fromBlock: number;
    toBlock: number;
    blocks: number;
    approxMinutes: number;
    complete: boolean;
    error: string | null;
  };
  findings: Finding[];
  summary: { high: number; medium: number; low: number; clear: number; notChecked: number };
}

export interface MultiReport {
  reports: LeakReport[];
  links: Finding;
}

export class LeakCheckError extends Error {
  constructor(
    readonly code: "bad-input" | "rpc-failed",
    message: string,
  ) {
    super(message);
    this.name = "LeakCheckError";
  }
}

const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

/** Symbol and decimals of each token, one Multicall3 eth_call. Unknown tokens are left out. */
export async function tokenMeta(rpcs: Rpcs, tokens: Address[]): Promise<Record<string, TokenMeta>> {
  const out: Record<string, TokenMeta> = {};
  const list = [...new Set(tokens.map(lc))].sort().slice(0, 60);
  if (!list.length) return out;
  const calls = list.flatMap((t) => [
    { target: t, allowFailure: true, callData: encodeFunctionData({ abi: erc20, functionName: "symbol" }) },
    { target: t, allowFailure: true, callData: encodeFunctionData({ abi: erc20, functionName: "decimals" }) },
  ]);
  try {
    const data = encodeFunctionData({ abi: multicallAbi, functionName: "aggregate3", args: [calls] });
    const raw = (await rpcs.read("eth_call", [{ to: RHC.multicall3, data }, "latest"])) as Hex;
    const res = decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data: raw });
    list.forEach((t, i) => {
      const s = res[i * 2]!;
      const d = res[i * 2 + 1]!;
      if (!d.success || d.returnData === "0x") return;
      try {
        const decimals = Number(decodeFunctionResult({ abi: erc20, functionName: "decimals", data: d.returnData }));
        const symbol = s.success
          ? String(decodeFunctionResult({ abi: erc20, functionName: "symbol", data: s.returnData })).slice(0, 24)
          : "?";
        out[t] = { symbol, decimals };
      } catch {
        // A token whose metadata doesn't decode keeps raw amounts in the report.
      }
    });
  } catch {
    // Metadata is cosmetic: amounts fall back to raw units.
  }
  return out;
}

async function readWallet(
  rpcs: Rpcs,
  address: Address,
  from: number,
  to: number,
  opts: CheckOptions,
): Promise<WalletData> {
  const [nonceHex, code, tr] = await Promise.all([
    rpcs.read("eth_getTransactionCount", [address, "latest"]) as Promise<Hex>,
    rpcs.read("eth_getCode", [address, "latest"]) as Promise<Hex>,
    walletTransfers(rpcs.logs, address, from, to, opts.logs),
  ]).catch((e: Error) => {
    throw new LeakCheckError("rpc-failed", `RPC failed: ${String(e.message).split("\n")[0]!.slice(0, 200)}`);
  });
  const kind: WalletData["kind"] = code === "0x" ? "eoa" : code.startsWith("0xef0100") ? "eip7702" : "contract";

  let funding: WalletData["funding"];
  let fundingError: string | undefined;
  if (opts.funding !== false && kind === "eoa") {
    try {
      funding = await findFunding(rpcs.archive, rpcs.read, address, to);
    } catch (e) {
      fundingError = `The archive RPC did not answer the first-funding search: ${String((e as Error).message)
        .split("\n")[0]!
        .slice(0, 160)}`;
    }
  }

  // Token senders other than swap payouts, newest first.
  const senderList: Address[] = [];
  for (const t of [...tr.incoming].reverse())
    if (!isSwapSource(t.from) && t.from !== address && !senderList.includes(t.from)) senderList.push(t.from);
  let senders: SenderFanout[] | null = null;
  try {
    senders = await Promise.all(
      senderList
        .slice(0, MAX_SENDERS)
        .map(async (sender): Promise<SenderFanout> => {
          const [c, r] = await Promise.all([
            rpcs.read("eth_getCode", [sender, "latest"]) as Promise<Hex>,
            getLogsChunked(rpcs.logs, { topics: [TRANSFER_TOPIC, addressTopic(sender)] }, from, to, opts.logs),
          ]);
          const sent = parseTransfers(r.logs);
          return {
            sender,
            isContract: c !== "0x" && !c.startsWith("0xef0100"),
            toWallet: sent.filter((t) => t.to === address),
            toOthers: sent.filter((t) => t.to !== address && t.to !== sender && !isSwapSource(t.to)),
            complete: r.complete,
          };
        })
        .map((p, i) =>
          p.catch(() => ({ sender: senderList[i]!, isContract: false, toWallet: [], toOthers: [], complete: false })),
        ),
    );
  } catch {
    senders = null;
  }

  const tracker =
    opts.tracker === false
      ? null
      : await trackerCheck(rpcs.logs, address, tr.incoming, to, opts.logs).catch(() => null);

  const tokens = await tokenMeta(
    rpcs,
    [...tr.incoming, ...tr.outgoing, ...(senders ?? []).flatMap((s) => [...s.toWallet, ...s.toOthers])].map(
      (t) => t.token,
    ),
  );
  return {
    address,
    kind,
    nonce: Number(BigInt(nonceHex)),
    window: { fromBlock: from, toBlock: to, complete: tr.complete, error: tr.error },
    outgoing: tr.outgoing,
    incoming: tr.incoming,
    funding,
    fundingError,
    senders,
    tracker,
    tokens,
  };
}

function toReport(d: WalletData, findings: Finding[]): LeakReport {
  const count = (f: (x: Finding) => boolean) => findings.filter(f).length;
  const blocks = d.window.toBlock - d.window.fromBlock + 1;
  return {
    spec: SPEC_VERSION,
    chainId: CHAIN_ID,
    address: getAddress(d.address) as Address,
    kind: d.kind,
    nonce: d.nonce,
    window: { ...d.window, blocks, approxMinutes: Math.round((blocks * BLOCK_TIME) / 60) },
    findings,
    summary: {
      high: count((f) => f.status === "found" && f.severity === "high"),
      medium: count((f) => f.status === "found" && f.severity === "medium"),
      low: count((f) => f.status === "found" && f.severity === "low"),
      clear: count((f) => f.status === "clear"),
      notChecked: count((f) => f.status === "not-checked"),
    },
  };
}

async function windowFor(rpcs: Rpcs, opts: CheckOptions) {
  const blocks = opts.blocks ?? DEFAULT_BLOCKS;
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > MAX_BLOCKS)
    throw new LeakCheckError("bad-input", `blocks must be an integer from 1 to ${MAX_BLOCKS.toLocaleString("en-US")}`);
  let to = opts.toBlock;
  if (to === undefined) {
    const head = await (rpcs.read("eth_blockNumber", []) as Promise<Hex>).catch((e: Error) => {
      throw new LeakCheckError("rpc-failed", `RPC failed: ${String(e.message).slice(0, 200)}`);
    });
    to = Number(BigInt(head)) - HEAD_LAG;
  }
  return { from: Math.max(0, to - blocks + 1), to };
}

function parseAddress(input: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input)) throw new LeakCheckError("bad-input", `Not an address: ${input}`);
  return lc(input);
}

/** Runs every rule for one wallet over a recent window of public logs. */
export async function leakCheck(input: string, opts: CheckOptions = {}): Promise<LeakReport> {
  const address = parseAddress(input);
  const rpcs = opts.rpcs ?? makeRpcs(opts);
  const { from, to } = await windowFor(rpcs, opts);
  const d = await readWallet(rpcs, address, from, to, opts);
  return toReport(d, runRules(d));
}

/** Checks several wallets over the same window, plus the links between them. */
export async function leakCheckMany(inputs: string[], opts: CheckOptions = {}): Promise<MultiReport> {
  const addresses = [...new Set(inputs.map(parseAddress))];
  if (addresses.length < 2) throw new LeakCheckError("bad-input", "Give at least two different addresses");
  const rpcs = opts.rpcs ?? makeRpcs(opts);
  const { from, to } = await windowFor(rpcs, opts);
  const data: WalletData[] = [];
  for (const a of addresses) data.push(await readWallet(rpcs, a, from, to, opts));
  return { reports: data.map((d) => toReport(d, runRules(d))), links: walletLinks(data) };
}
