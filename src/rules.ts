/**
 * The rules. Each one is a pure function of the data read from the chain and returns one finding: what links the
 * wallet to its trades, how strongly (severity), the transactions that show it (evidence) and what removes it (fix).
 */
import { formatUnits, getAddress } from "viem";
import { BLOCK_TIME, isSwapSource, type Address, type Hex } from "./chain.js";
import type { Funding } from "./funder.js";
import type { TrackerResult } from "./tracker.js";
import type { Transfer } from "./transfers.js";

export type Severity = "high" | "medium" | "low" | "none";
export type RuleId =
  | "address-reuse"
  | "amount-match"
  | "round-amounts"
  | "timing"
  | "gas-funder"
  | "shared-funder"
  | "tracker"
  | "wallet-links";

export interface Evidence {
  tx: Hex;
  block?: number;
  note: string;
}

export interface Finding {
  id: RuleId;
  title: string;
  /** found = the link exists; clear = checked, nothing found; not-checked = data was missing. */
  status: "found" | "clear" | "not-checked";
  severity: Severity;
  detail: string;
  evidence: Evidence[];
  fix: string;
}

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

export interface Window {
  fromBlock: number;
  toBlock: number;
  complete: boolean;
  error: string | null;
}

/** ERC-20 transfers a sender made in the window, other than to the wallet. */
export interface SenderFanout {
  sender: Address;
  isContract: boolean;
  toWallet: Transfer[];
  toOthers: Transfer[];
  complete: boolean;
}

export interface WalletData {
  address: Address;
  kind: "eoa" | "eip7702" | "contract";
  nonce: number;
  window: Window;
  outgoing: Transfer[];
  incoming: Transfer[];
  /** undefined = not checked; null = never funded. */
  funding?: Funding | null;
  fundingError?: string;
  /** null = not checked. */
  senders: SenderFanout[] | null;
  /** null = not checked. */
  tracker: TrackerResult | null;
  tokens: Record<string, TokenMeta>;
}

/** Thresholds, fixed so results are comparable. */
export const LIMITS = {
  /** Outgoing transfer within this many blocks after an incoming one (~2 s). */
  fastBlocks: 20,
  /** Two amounts "match" when they differ by at most this many bps. */
  matchBps: 10n,
  /** Round = at most this many significant digits. */
  roundDigits: 2,
  /** Ignore transfers below this raw value for the round-amount rule (dust). */
  roundMinRaw: 10_000n,
  /** A funder with fewer sent transactions than this is treated as a personal wallet. */
  personalNonce: 1000,
  /** A sender that paid at least this many other addresses is treated as a busy distributor. */
  busyRecipients: 50,
  /** Most evidence items per finding. */
  maxEvidence: 6,
} as const;

const minutes = (blocks: number) => Math.max(1, Math.round((blocks * BLOCK_TIME) / 60));
export const windowLabel = (w: Window) =>
  `in the last ~${minutes(w.toBlock - w.fromBlock + 1)} min (blocks ${w.fromBlock.toLocaleString("en-US")}–${w.toBlock.toLocaleString("en-US")})`;

export function amountLabel(t: { token: Address; value: bigint }, tokens: Record<string, TokenMeta>) {
  const m = tokens[t.token];
  if (!m) return `${t.value} raw of ${t.token}`;
  const n = Number(formatUnits(t.value, m.decimals));
  return `${n.toLocaleString("en-US", { maximumSignificantDigits: 8 })} ${m.symbol}`;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Significant digits of a raw amount; decimals don't change them. */
export function significantDigits(raw: bigint): number {
  if (raw === 0n) return 0;
  return (raw < 0n ? -raw : raw).toString().replace(/0+$/, "").length;
}

export const isRound = (raw: bigint) => raw >= LIMITS.roundMinRaw && significantDigits(raw) <= LIMITS.roundDigits;

function uniqTx<T extends { tx: Hex }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.tx) ? false : (seen.add(i.tx), true)));
}

/* ------------------------------------------------------------------ address reuse */

export function addressReuse(d: WalletData): Finding {
  const fix = "Trade from a fresh address each time, so one trade can't be joined to the others.";
  const n = d.nonce;
  const sent = uniqTx([...d.outgoing].reverse()).slice(0, LIMITS.maxEvidence);
  const evidence = sent.map((t) => ({
    tx: t.tx,
    block: t.block,
    note: `Sent ${amountLabel(t, d.tokens)} from this address`,
  }));
  if (n === 0)
    return {
      id: "address-reuse",
      title: "No transactions sent",
      status: "clear",
      severity: "none",
      detail: "This address has never sent a transaction.",
      evidence: [],
      fix,
    };
  const severity: Severity = n >= 100 ? "high" : n >= 20 ? "medium" : "low";
  return {
    id: "address-reuse",
    title: `Reused address: ${n.toLocaleString("en-US")} transaction${n > 1 ? "s" : ""} sent`,
    status: "found",
    severity,
    detail:
      "Every transaction from one address is linkable to every other one from it. The more trades share an address, the more of your history one lookup reveals.",
    evidence,
    fix,
  };
}

/* ------------------------------------------------------------------ amount matches */

/** Outgoing transfers that pass on (almost) exactly an amount received earlier in the same token. */
export function amountMatches(d: WalletData): { inn: Transfer; out: Transfer; exact: boolean }[] {
  const used = new Set<Transfer>();
  const pairs: { inn: Transfer; out: Transfer; exact: boolean }[] = [];
  for (const out of d.outgoing) {
    if (isSwapSource(out.to) || out.value === 0n) continue;
    let best: Transfer | null = null;
    for (const inn of d.incoming) {
      if (used.has(inn) || inn.token !== out.token || inn.tx === out.tx || inn.block > out.block) continue;
      const diff = inn.value > out.value ? inn.value - out.value : out.value - inn.value;
      if (diff * 10_000n > inn.value * LIMITS.matchBps) continue;
      if (!best || inn.block > best.block) best = inn;
    }
    if (best) {
      used.add(best);
      pairs.push({ inn: best, out, exact: best.value === out.value });
    }
  }
  return pairs;
}

export function amountMatch(d: WalletData): Finding {
  const fix =
    "Don't pass on the exact amount you received. Split it, keep part, or send in irregular sizes so the two sides can't be paired.";
  const pairs = amountMatches(d);
  const win = windowLabel(d.window);
  if (!pairs.length)
    return {
      id: "amount-match",
      title: `No matching in and out amounts ${win}`,
      status: d.window.complete ? "clear" : "not-checked",
      severity: "none",
      detail: d.window.complete
        ? "No outgoing transfer repeats an amount this address received."
        : "The log RPC did not return the whole window.",
      evidence: [],
      fix,
    };
  const exact = pairs.filter((p) => p.exact).length;
  const evidence = pairs.slice(-LIMITS.maxEvidence / 2).flatMap(({ inn, out, exact: ex }) => [
    { tx: inn.tx, block: inn.block, note: `Received ${amountLabel(inn, d.tokens)} from ${short(inn.from)}` },
    {
      tx: out.tx,
      block: out.block,
      note: `${ex ? "Sent the same" : "Sent almost the same"} ${amountLabel(out, d.tokens)} to ${short(out.to)}`,
    },
  ]);
  return {
    id: "amount-match",
    title: `${pairs.length} amount match${pairs.length > 1 ? "es" : ""} ${win}`,
    status: "found",
    severity: exact ? "high" : "medium",
    detail: `An amount that comes in and goes out unchanged (${exact} exact, ${pairs.length - exact} within ${LIMITS.matchBps} bps) ties the sender, this address and the recipient into one flow.`,
    evidence,
    fix,
  };
}

/* ------------------------------------------------------------------ round amounts */

export function roundAmounts(d: WalletData): Finding {
  const fix = "Use irregular sizes (1,037.42 rather than 1,000) so amounts can't be matched across addresses.";
  const win = windowLabel(d.window);
  const round = uniqTx(
    [...d.incoming, ...d.outgoing].filter((t) => isRound(t.value)).sort((a, b) => a.block - b.block),
  );
  if (!round.length)
    return {
      id: "round-amounts",
      title: `No round-amount transfers ${win}`,
      status: d.window.complete ? "clear" : "not-checked",
      severity: "none",
      detail: "Transfer sizes don't stand out.",
      evidence: [],
      fix,
    };
  return {
    id: "round-amounts",
    title: `${round.length} round-amount transfer${round.length > 1 ? "s" : ""} ${win}`,
    status: "found",
    severity: round.length >= 3 ? "medium" : "low",
    detail: "Round amounts are the easiest to match against a deposit or withdrawal on another address.",
    evidence: round.slice(-LIMITS.maxEvidence).map((t) => ({
      tx: t.tx,
      block: t.block,
      note: `${t.to === d.address ? "Received" : "Sent"} ${amountLabel(t, d.tokens)}`,
    })),
    fix,
  };
}

/* ------------------------------------------------------------------ timing */

/** Outgoing transfers within LIMITS.fastBlocks blocks after an incoming one (other transaction, later block). */
export function fastPairs(d: WalletData): { inn: Transfer; out: Transfer }[] {
  const pairs: { inn: Transfer; out: Transfer }[] = [];
  for (const out of d.outgoing) {
    let best: Transfer | null = null;
    for (const inn of d.incoming) {
      const gap = out.block - inn.block;
      if (gap <= 0 || gap > LIMITS.fastBlocks || inn.tx === out.tx) continue;
      if (!best || inn.block > best.block) best = inn;
    }
    if (best) pairs.push({ inn: best, out });
  }
  return pairs;
}

export function timing(d: WalletData): Finding {
  const fix = "Leave a longer, random delay between receiving funds and moving them on.";
  const win = windowLabel(d.window);
  const pairs = fastPairs(d);
  if (!pairs.length)
    return {
      id: "timing",
      title: `No fast in-and-out ${win}`,
      status: d.window.complete ? "clear" : "not-checked",
      severity: "none",
      detail: `No outgoing transfer within ${LIMITS.fastBlocks} blocks (~2 s) of an incoming one.`,
      evidence: [],
      fix,
    };
  return {
    id: "timing",
    title: `${pairs.length} transfer${pairs.length > 1 ? "s" : ""} out within ~2 s of funds arriving`,
    status: "found",
    severity: pairs.length >= 3 ? "high" : "medium",
    detail: `Funds that leave within ${LIMITS.fastBlocks} blocks of arriving link the incoming and the outgoing side by timing alone.`,
    evidence: pairs.slice(-LIMITS.maxEvidence / 2).flatMap(({ inn, out }) => [
      { tx: inn.tx, block: inn.block, note: `Received ${amountLabel(inn, d.tokens)}` },
      {
        tx: out.tx,
        block: out.block,
        note: `Sent ${amountLabel(out, d.tokens)} ${out.block - inn.block} block${out.block - inn.block > 1 ? "s" : ""} later`,
      },
    ]),
    fix,
  };
}

/* ------------------------------------------------------------------ gas funder */

export function gasFunder(d: WalletData): Finding {
  const fix =
    "Fund each trading wallet's gas from a source that isn't tied to your other wallets, not straight from your main wallet.";
  const base = { id: "gas-funder" as const, fix };
  if (d.funding === undefined)
    return {
      ...base,
      title: "Gas funder: not checked",
      status: "not-checked",
      severity: "none",
      detail:
        d.fundingError ??
        (d.kind === "eoa"
          ? "The first-funding search was skipped."
          : "Only plain wallets (EOAs) are searched: a contract or EIP-7702 account can move ETH without its nonce."),
      evidence: [],
    };
  const f = d.funding;
  if (f === null)
    return {
      ...base,
      title: "Never funded",
      status: "clear",
      severity: "none",
      detail: "This address has never held ETH or sent a transaction.",
      evidence: [],
    };
  if (!f.funder || !f.tx)
    return {
      ...base,
      title: `First funded in block ${f.block.toLocaleString("en-US")}`,
      status: "found",
      severity: "low",
      detail: `The ETH arrived in block ${f.block.toLocaleString("en-US")}, through a contract call among ${f.candidates.length} transactions in that block; the funding one can't be told apart without a trace.`,
      evidence: f.candidates
        .slice(0, LIMITS.maxEvidence)
        .map((tx) => ({ tx, block: f.block, note: "Transaction in the funding block" })),
    };
  const who = getAddress(f.funder);
  const via = f.how === "only-tx" ? " (through a contract it called)" : "";
  const evidence = [{ tx: f.tx, block: f.block, note: `First ETH from ${who}${via}` }];
  if (f.funderIsContract)
    return {
      ...base,
      title: `Funded by contract ${short(who)}`,
      status: "found",
      severity: "medium",
      detail: `The first ETH came from a contract (bridge, faucet, disperser or smart account) at ${who}. Its operator and anyone who reads its inputs can link the two.`,
      evidence,
    };
  const n = f.funderNonce ?? 0;
  if (n >= LIMITS.personalNonce)
    return {
      ...base,
      title: `Funded by a busy wallet ${short(who)}`,
      status: "found",
      severity: "low",
      detail: `The first ETH came from ${who}, which has sent ${n.toLocaleString("en-US")} transactions (an exchange, bot or hot wallet). That hides you in a crowd publicly, but its operator can link you.`,
      evidence,
    };
  return {
    ...base,
    title: `Funded by wallet ${short(who)}`,
    status: "found",
    severity: "high",
    detail: `The first ETH came from ${who}, a wallet with ${n.toLocaleString("en-US")} sent transaction${n === 1 ? "" : "s"}. Anyone can follow the funding back to it and to everything else it funded.`,
    evidence,
  };
}

/* ------------------------------------------------------------------ shared funders */

export function sharedFunder(d: WalletData): Finding {
  const fix =
    "Don't fund trading wallets from one shared source; each one funded from the same address is linked to the rest.";
  const win = windowLabel(d.window);
  if (!d.senders)
    return {
      id: "shared-funder",
      title: "Shared funders: not checked",
      status: "not-checked",
      severity: "none",
      detail: "The log RPC did not answer for the senders' transfers.",
      evidence: [],
      fix,
    };
  const shared = d.senders.filter((s) => s.toOthers.length > 0);
  if (!shared.length)
    return {
      id: "shared-funder",
      title: `No shared funders ${win}`,
      status: d.senders.every((s) => s.complete) && d.window.complete ? "clear" : "not-checked",
      severity: "none",
      detail: d.senders.length
        ? `None of the ${d.senders.length} address${d.senders.length > 1 ? "es" : ""} that sent tokens here (other than swap payouts) sent tokens to anyone else in the window.`
        : "No tokens arrived here other than swap payouts.",
      evidence: [],
      fix,
    };
  const recipients = (s: SenderFanout) => new Set(s.toOthers.map((t) => t.to)).size;
  const personal = shared.filter((s) => !s.isContract && recipients(s) < LIMITS.busyRecipients);
  const evidence = shared.slice(0, 3).flatMap((s) => [
    ...s.toWallet
      .slice(-1)
      .map((t) => ({ tx: t.tx, block: t.block, note: `${short(s.sender)} sent ${amountLabel(t, d.tokens)} here` })),
    ...uniqTx(s.toOthers)
      .slice(-2)
      .map((t) => ({
        tx: t.tx,
        block: t.block,
        note: `${short(s.sender)} also sent ${amountLabel(t, d.tokens)} to ${short(t.to)}`,
      })),
  ]);
  return {
    id: "shared-funder",
    title: `${shared.length} sender${shared.length > 1 ? "s" : ""} also funded other addresses ${win}`,
    status: "found",
    severity: personal.length ? "medium" : "low",
    detail: shared
      .map(
        (s) =>
          `${getAddress(s.sender)}${s.isContract ? " (contract)" : ""} paid ${recipients(s)} other address${recipients(s) > 1 ? "es" : ""}`,
      )
      .join("; ")
      .concat(". Addresses paid by the same sender are easy to cluster together."),
    evidence: evidence.slice(0, LIMITS.maxEvidence),
    fix,
  };
}

/* ------------------------------------------------------------------ tracker */

export function tracker(d: WalletData): Finding {
  const fix = "Copy-trade bots key on a known wallet. Trades from fresh addresses give them nothing to follow.";
  const win = windowLabel(d.window);
  const t = d.tracker;
  if (!t)
    return {
      id: "tracker",
      title: "Tracker check: not checked",
      status: "not-checked",
      severity: "none",
      detail: "The log RPC did not answer.",
      evidence: [],
      fix,
    };
  if (!t.trades.length)
    return {
      id: "tracker",
      title: `No swap outputs ${win}`,
      status: d.window.complete ? "clear" : "not-checked",
      severity: "none",
      detail: "No tokens arrived from the Uniswap PoolManager or a Uniswap router, so there is nothing to follow.",
      evidence: [],
      fix,
    };
  if (!t.followers.length)
    return {
      id: "tracker",
      title: `Nobody followed more than one of ${t.trades.length} trade${t.trades.length > 1 ? "s" : ""}`,
      status: t.complete ? "clear" : "not-checked",
      severity: "none",
      detail: `For each recent swap output, the same token from the same source went to ${t.trades.map((x) => x.buyersAfter).join(", ")} other address(es) in the next 100 blocks (~10 s), but no address did so twice. One follower on a popular token is noise; repeats are the signal.`,
      evidence: t.trades.slice(0, LIMITS.maxEvidence).map((x) => ({ tx: x.tx, block: x.block, note: "Your trade" })),
      fix,
    };
  const top = t.followers[0]!;
  const evidence: Evidence[] = [
    ...t.followers.slice(0, 2).flatMap((f) =>
      f.txs.slice(0, 2).map((tx) => ({
        tx,
        note: `${short(f.address)} received the same token right after your trade (followed ${f.trades} trades, fastest ${f.minDelayBlocks} block${f.minDelayBlocks > 1 ? "s" : ""})`,
      })),
    ),
    ...t.trades.slice(0, 2).map((x) => ({ tx: x.tx, block: x.block, note: "Your trade" })),
  ];
  return {
    id: "tracker",
    title: `${t.followers.length} address${t.followers.length > 1 ? "es" : ""} followed more than one trade`,
    status: "found",
    severity: t.followers.length >= 2 || top.trades >= 3 ? "high" : "medium",
    detail: t.followers
      .map(
        (f) => `${f.address} after ${f.trades} of your ${t.trades.length} trades, fastest ${f.minDelayBlocks} block(s)`,
      )
      .join("; ")
      .concat(". An address that keeps buying the same token right after you is likely copying this wallet."),
    evidence: evidence.slice(0, LIMITS.maxEvidence),
    fix,
  };
}

/* ------------------------------------------------------------------ several wallets */

/** Links between wallets checked together: direct transfers, the same gas funder, the same token sender. */
export function walletLinks(wallets: WalletData[]): Finding {
  const fix = "Keep the wallets apart: no transfers between them, and separate funding for each.";
  const set = new Set(wallets.map((w) => w.address));
  const evidence: Evidence[] = [];
  const lines: string[] = [];
  let direct = 0;
  for (const w of wallets)
    for (const t of w.outgoing)
      if (set.has(t.to) && t.to !== w.address) {
        direct++;
        evidence.push({
          tx: t.tx,
          block: t.block,
          note: `${short(w.address)} sent ${amountLabel(t, w.tokens)} to ${short(t.to)}`,
        });
      }
  if (direct) lines.push(`${direct} direct transfer${direct > 1 ? "s" : ""} between the wallets`);
  const byFunder = new Map<string, WalletData[]>();
  for (const w of wallets)
    if (w.funding?.funder) byFunder.set(w.funding.funder, [...(byFunder.get(w.funding.funder) ?? []), w]);
  let sameFunder = 0;
  for (const [funder, ws] of byFunder)
    if (ws.length > 1) {
      sameFunder++;
      lines.push(`${ws.length} wallets first funded by ${getAddress(funder)}`);
      for (const w of ws)
        evidence.push({ tx: w.funding!.tx!, block: w.funding!.block, note: `Gas for ${short(w.address)}` });
    }
  const bySender = new Map<string, Set<string>>();
  for (const w of wallets)
    for (const t of w.incoming)
      if (!isSwapSource(t.from) && !set.has(t.from))
        bySender.set(t.from, (bySender.get(t.from) ?? new Set()).add(w.address));
  const common = [...bySender.entries()].filter(([, s]) => s.size > 1);
  for (const [sender, s] of common) lines.push(`${getAddress(sender)} sent tokens to ${s.size} of the wallets`);
  if (!lines.length)
    return {
      id: "wallet-links",
      title: `No links between the ${wallets.length} wallets`,
      status: wallets.every((w) => w.window.complete) ? "clear" : "not-checked",
      severity: "none",
      detail: "No transfers between them, no shared gas funder and no shared token sender in the window.",
      evidence: [],
      fix,
    };
  return {
    id: "wallet-links",
    title: `The ${wallets.length} wallets are linked`,
    status: "found",
    severity: direct || sameFunder ? "high" : "medium",
    detail: lines.join("; ") + ".",
    evidence: evidence.slice(0, LIMITS.maxEvidence),
    fix,
  };
}

/** Every single-wallet rule, in report order. */
export function runRules(d: WalletData): Finding[] {
  return [addressReuse(d), amountMatch(d), roundAmounts(d), timing(d), gasFunder(d), sharedFunder(d), tracker(d)];
}
