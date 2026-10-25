import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex, Recording, Transfer, WalletData } from "../src/index.js";

export interface Fixture {
  name: string;
  description: string;
  addresses: string[];
  options: { toBlock: number; blocks: number };
  expected: Record<string, unknown>;
  rpc: Recording;
}

const dir = join(import.meta.dirname, "..", "fixtures");

export const fixtures: Fixture[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture);

export const fixture = (name: string) => {
  const f = fixtures.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
};

export const ME = "0x1111111111111111111111111111111111111111" as Address;
export const TOKEN = "0x00000000000000000000000000000000000000a1" as Address;
export const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;

let n = 0;
export const txh = () => `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
export const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Address;

export const t = (from: Address, to: Address, value: bigint, block: number, token: Address = TOKEN): Transfer => ({
  token,
  from,
  to,
  value,
  block,
  tx: txh(),
  logIndex: 0,
});

export function wallet(over: Partial<WalletData> = {}): WalletData {
  return {
    address: ME,
    kind: "eoa",
    nonce: 0,
    window: { fromBlock: 1000, toBlock: 15_999, complete: true, error: null },
    outgoing: [],
    incoming: [],
    funding: null,
    senders: [],
    tracker: { trades: [], followers: [], complete: true },
    tokens: { [TOKEN]: { symbol: "TKN", decimals: 18 } },
    ...over,
  };
}
