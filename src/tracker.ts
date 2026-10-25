/**
 * Tracker check: for each recent swap output to the wallet, who received the same token from the same source in the
 * next 100 blocks (~10 s)? An address that shows up after two or more of the wallet's trades is a likely follower.
 */
import { getAddress } from "viem";
import { isSwapSource, lc, type Address, type Hex } from "./chain.js";
import { getLogsChunked, type GetLogsOptions, type RpcRequest } from "./rpc.js";
import { addressTopic, parseTransfers, TRANSFER_TOPIC, type Transfer } from "./transfers.js";

/** Blocks after a trade searched for followers (~10 s at 0.105 s per block). */
export const FOLLOW_BLOCKS = 100;
/** Most recent trades checked. */
export const MAX_TRADES = 6;

export interface TrackedTrade {
  token: Address;
  block: number;
  tx: Hex;
  value: bigint;
  /** Distinct addresses that received the same token from the same source in the next FOLLOW_BLOCKS blocks. */
  buyersAfter: number;
  complete: boolean;
}

export interface Follower {
  address: Address;
  /** Trades of the wallet this address followed. */
  trades: number;
  tokens: Address[];
  /** Smallest delay in blocks after one of the wallet's trades. */
  minDelayBlocks: number;
  /** The follower's transactions, one per followed trade. */
  txs: Hex[];
}

export interface TrackerResult {
  trades: TrackedTrade[];
  followers: Follower[];
  complete: boolean;
}

/** Newest swap outputs, one per (token, block). */
export function swapOutputs(incoming: readonly Transfer[], max = MAX_TRADES): Transfer[] {
  const out: Transfer[] = [];
  const seen = new Set<string>();
  for (const t of [...incoming].reverse()) {
    if (!isSwapSource(t.from)) continue;
    const k = `${t.token}:${t.block}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Pure part: given the transfers that followed each trade, count repeat followers. */
export function followersOf(
  wallet: Address,
  after: { trade: Transfer; transfers: Transfer[] }[],
): { perTrade: number[]; followers: Follower[] } {
  const me = lc(wallet);
  const map = new Map<Address, { trades: number; tokens: Set<Address>; minDelay: number; txs: Hex[] }>();
  const perTrade = after.map(({ trade, transfers }) => {
    const first = new Map<Address, Transfer>();
    for (const x of transfers) {
      if (x.to === me || x.block <= trade.block) continue;
      const prev = first.get(x.to);
      if (!prev || x.block < prev.block) first.set(x.to, x);
    }
    for (const [who, x] of first) {
      const f = map.get(who) ?? { trades: 0, tokens: new Set<Address>(), minDelay: Infinity, txs: [] };
      f.trades++;
      f.tokens.add(trade.token);
      f.minDelay = Math.min(f.minDelay, x.block - trade.block);
      f.txs.push(x.tx);
      map.set(who, f);
    }
    return first.size;
  });
  const followers = [...map.entries()]
    .filter(([, f]) => f.trades >= 2)
    .map(([address, f]) => ({
      address: getAddress(address) as Address,
      trades: f.trades,
      tokens: [...f.tokens],
      minDelayBlocks: f.minDelay,
      txs: f.txs,
    }))
    .sort((x, y) => y.trades - x.trades || x.minDelayBlocks - y.minDelayBlocks);
  return { perTrade, followers };
}

export async function trackerCheck(
  logs: RpcRequest,
  wallet: Address,
  incoming: readonly Transfer[],
  head: number,
  opts?: GetLogsOptions,
): Promise<TrackerResult> {
  const trades = swapOutputs(incoming);
  const after = await Promise.all(
    trades.map(async (trade) => {
      const to = Math.min(head, trade.block + FOLLOW_BLOCKS);
      const r = await getLogsChunked(
        logs,
        { address: trade.token, topics: [TRANSFER_TOPIC, addressTopic(trade.from)] },
        trade.block + 1,
        to,
        opts,
      );
      return { trade, transfers: parseTransfers(r.logs), complete: r.complete };
    }),
  );
  const { perTrade, followers } = followersOf(wallet, after);
  return {
    trades: after.map(({ trade, complete }, i) => ({
      token: trade.token,
      block: trade.block,
      tx: trade.tx,
      value: trade.value,
      buyersAfter: perTrade[i]!,
      complete,
    })),
    followers,
    complete: after.every((a) => a.complete),
  };
}
