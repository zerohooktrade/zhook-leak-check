import { keccak256, pad, toBytes } from "viem";
import { lc, type Address, type Hex } from "./chain.js";
import { getLogsChunked, type GetLogsOptions, type RawLog, type RpcRequest } from "./rpc.js";

export const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));

/** One ERC-20 Transfer log. */
export interface Transfer {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  block: number;
  tx: Hex;
  logIndex: number;
}

/** Decodes ERC-20 Transfer logs (three topics); ERC-721 transfers (four topics) are skipped. */
export function parseTransfers(logs: readonly RawLog[]): Transfer[] {
  const out: Transfer[] = [];
  for (const l of logs) {
    if (l.topics.length !== 3 || l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    out.push({
      token: lc(l.address),
      from: lc("0x" + l.topics[1]!.slice(26)),
      to: lc("0x" + l.topics[2]!.slice(26)),
      value: l.data === "0x" ? 0n : BigInt(l.data),
      block: parseInt(l.blockNumber, 16),
      tx: l.transactionHash.toLowerCase() as Hex,
      logIndex: parseInt(l.logIndex, 16),
    });
  }
  return out;
}

export const addressTopic = (a: Address) => pad(lc(a), { size: 32 }) as Hex;

/** ERC-20 transfers sent by and to `address` over [from, to]. */
export async function walletTransfers(
  logs: RpcRequest,
  address: Address,
  from: number,
  to: number,
  opts?: GetLogsOptions,
): Promise<{ outgoing: Transfer[]; incoming: Transfer[]; complete: boolean; error: string | null }> {
  const t = addressTopic(address);
  const [out, inn] = await Promise.all([
    getLogsChunked(logs, { topics: [TRANSFER_TOPIC, t] }, from, to, opts),
    getLogsChunked(logs, { topics: [TRANSFER_TOPIC, null, t] }, from, to, opts),
  ]);
  return {
    outgoing: parseTransfers(out.logs),
    incoming: parseTransfers(inn.logs),
    complete: out.complete && inn.complete,
    error: out.error ?? inn.error,
  };
}
