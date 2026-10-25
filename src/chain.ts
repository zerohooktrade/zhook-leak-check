/**
 * Robinhood Chain (chain id 4663) constants. Every address was read on-chain with eth_getCode.
 */
export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export const CHAIN_ID = 4663;
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

export const RHC = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  explorer: "https://robinhoodchain.blockscout.com",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const;

/** Seconds per block, measured over ~1M blocks (978,858 blocks in 102,867 s). */
export const BLOCK_TIME = 0.105;

/**
 * Public RPC defaults, no key needed.
 * - read: latest-block reads (nonce, code, block number).
 * - archive: reads at past blocks (first-funding search).
 * - logs: eth_getLogs. Measured from public endpoints: publicnode refuses getLogs, dRPC's free tier caps ranges at
 *   ~100 blocks, and thirdweb's public endpoint answers 1,000-block ranges.
 */
export const DEFAULT_RPCS = {
  read: ["https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org"],
  archive: ["https://robinhood.drpc.org"],
  logs: ["https://4663.rpc.thirdweb.com"],
} as const;

/** Max block span per eth_getLogs call on the default log RPC. */
export const LOG_SPAN = 1000;

export const lc = (a: string) => a.toLowerCase() as Address;
export const explorerTx = (hash: string) => `${RHC.explorer}/tx/${hash}`;
export const explorerAddress = (address: string) => `${RHC.explorer}/address/${address}`;

/** Addresses that pay out swap outputs: the v4 PoolManager and the Uniswap routers. */
export const SWAP_SOURCES: readonly Address[] = [RHC.poolManager, RHC.universalRouter, RHC.swapRouter02];
export const isSwapSource = (a: string) => SWAP_SOURCES.includes(lc(a));
