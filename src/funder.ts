/**
 * First funding of an address, without an indexer: binary search over block numbers on an archive node for the
 * first block where the address has a balance or has sent a transaction, then read that block's transactions.
 *
 * For a plain EOA the condition "balance > 0 or nonce > 0" never turns false again (its balance only goes down through
 * its own transactions, which raise the nonce), so the search is exact. It is not run for contracts or EIP-7702
 * accounts, whose balance can move without their nonce.
 */
import { lc, type Address, type Hex } from "./chain.js";
import type { RpcRequest } from "./rpc.js";

export interface Funding {
  /** First block where the address had ETH or a sent transaction. */
  block: number;
  /** The transaction that sent the ETH, when it is a plain transfer or call with value to the address. */
  tx: Hex | null;
  /** Who paid: tx.from of that transaction. */
  funder: Address | null;
  /** "direct" = tx.to is the address; "only-tx" = the only transaction in the block (ETH sent by a contract it called). */
  how: "direct" | "only-tx" | "unknown";
  /** The transactions of the block when the funding one can't be told apart. */
  candidates: Hex[];
  /** Funder activity: nonce and whether it has code. */
  funderNonce: number | null;
  funderIsContract: boolean | null;
}

const hex = (n: number) => `0x${n.toString(16)}`;

interface RpcTx {
  hash: Hex;
  from: Address;
  to: Address | null;
  value: Hex;
  type?: Hex;
}

/** Arbitrum system transactions (internal start-block messages) are not user transactions. */
const isSystemTx = (t: RpcTx) => t.type === "0x6a";

export async function findFunding(
  archive: RpcRequest,
  read: RpcRequest,
  address: Address,
  head: number,
): Promise<Funding | null> {
  const a = lc(address);
  const touched = async (b: number) => {
    const [bal, nonce] = await Promise.all([
      archive("eth_getBalance", [a, hex(b)]) as Promise<Hex>,
      archive("eth_getTransactionCount", [a, hex(b)]) as Promise<Hex>,
    ]);
    return BigInt(bal) > 0n || BigInt(nonce) > 0n;
  };
  if (!(await touched(head))) return null;
  let lo = 0;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await touched(mid)) hi = mid;
    else lo = mid + 1;
  }
  const block = (await archive("eth_getBlockByNumber", [hex(lo), true])) as { transactions: RpcTx[] } | null;
  const txs = (block?.transactions ?? []).filter((t) => !isSystemTx(t));
  const direct = txs.find((t) => t.to && lc(t.to) === a && BigInt(t.value) > 0n);
  const pick = direct ?? (txs.length === 1 ? txs[0]! : null);
  const funder = pick ? lc(pick.from) : null;
  let funderNonce: number | null = null;
  let funderIsContract: boolean | null = null;
  if (funder) {
    const [n, code] = await Promise.all([
      read("eth_getTransactionCount", [funder, "latest"]) as Promise<Hex>,
      read("eth_getCode", [funder, "latest"]) as Promise<Hex>,
    ]);
    funderNonce = Number(BigInt(n));
    funderIsContract = code !== "0x" && !code.startsWith("0xef0100");
  }
  return {
    block: lo,
    tx: pick ? (pick.hash.toLowerCase() as Hex) : null,
    funder,
    how: direct ? "direct" : pick ? "only-tx" : "unknown",
    candidates: pick ? [] : txs.map((t) => t.hash.toLowerCase() as Hex),
    funderNonce,
    funderIsContract,
  };
}
