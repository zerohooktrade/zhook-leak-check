import { describe, expect, it } from "vitest";
import {
  addressTopic,
  findFunding,
  followersOf,
  getLogsChunked,
  parseTransfers,
  swapOutputs,
  TRANSFER_TOPIC,
  type RawLog,
  type RpcRequest,
} from "../src/index.js";
import { addr, ME, POOL_MANAGER, t } from "./helpers.js";

const hex = (n: number) => `0x${n.toString(16)}`;

describe("getLogsChunked", () => {
  it("splits the range into fixed spans and sorts the result", async () => {
    const ranges: [number, number][] = [];
    const request: RpcRequest = async (_m, p) => {
      const f = p[0] as { fromBlock: string; toBlock: string };
      const a = parseInt(f.fromBlock, 16);
      ranges.push([a, parseInt(f.toBlock, 16)]);
      return [{ blockNumber: hex(a), logIndex: "0x0" }];
    };
    const r = await getLogsChunked(request, { topics: [] }, 0, 2500, { span: 1000 });
    expect(ranges.sort((x, y) => x[0] - y[0])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2500],
    ]);
    expect(r.logs.map((l) => l.blockNumber)).toEqual(["0x0", "0x3e8", "0x7d0"]);
    expect(r.complete).toBe(true);
  });

  it("halves a failing range down to minSpan, then reports it incomplete", async () => {
    const request: RpcRequest = async (_m, p) => {
      const f = p[0] as { fromBlock: string; toBlock: string };
      if (parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16) + 1 > 250) throw new Error("range too large");
      if (parseInt(f.fromBlock, 16) === 0) throw new Error("boom");
      return [];
    };
    const r = await getLogsChunked(request, { topics: [] }, 0, 999, { span: 1000, minSpan: 250 });
    expect(r.complete).toBe(false);
    expect(r.error).toBe("boom");
  });

  it("returns nothing for an empty range", async () => {
    expect(await getLogsChunked(async () => [], { topics: [] }, 10, 9)).toEqual({
      logs: [],
      complete: true,
      error: null,
    });
  });
});

describe("parseTransfers", () => {
  it("decodes ERC-20 transfers and skips ERC-721", () => {
    const log = (topics: string[]): RawLog => ({
      address: "0x00000000000000000000000000000000000000A1",
      topics: topics as RawLog["topics"],
      data: "0x0000000000000000000000000000000000000000000000000000000000000064",
      blockNumber: "0x10",
      transactionHash: "0xABC",
      logIndex: "0x2",
    });
    const out = parseTransfers([
      log([TRANSFER_TOPIC, addressTopic(addr(1)), addressTopic(ME)]),
      log([TRANSFER_TOPIC, addressTopic(addr(1)), addressTopic(ME), "0x01"]),
    ]);
    expect(out).toEqual([
      {
        token: "0x00000000000000000000000000000000000000a1",
        from: addr(1),
        to: ME,
        value: 100n,
        block: 16,
        tx: "0xabc",
        logIndex: 2,
      },
    ]);
  });
});

describe("tracker helpers", () => {
  it("keeps the newest swap output per token and block", () => {
    const a = t(POOL_MANAGER, ME, 1n, 100);
    const b = t(POOL_MANAGER, ME, 2n, 100);
    const c = t(POOL_MANAGER, ME, 3n, 200);
    const d = t(addr(5), ME, 3n, 300);
    expect(swapOutputs([a, b, c, d])).toEqual([c, b]);
  });

  it("flags only addresses that followed two or more trades", () => {
    const tr1 = t(POOL_MANAGER, ME, 1n, 100);
    const tr2 = t(POOL_MANAGER, ME, 1n, 500);
    const F = addr(0xf0);
    const G = addr(0xf1);
    const { perTrade, followers } = followersOf(ME, [
      {
        trade: tr1,
        transfers: [
          t(POOL_MANAGER, F, 1n, 104),
          t(POOL_MANAGER, F, 1n, 103),
          t(POOL_MANAGER, G, 1n, 110),
          t(POOL_MANAGER, ME, 1n, 101),
        ],
      },
      { trade: tr2, transfers: [t(POOL_MANAGER, F, 1n, 509)] },
    ]);
    expect(perTrade).toEqual([2, 1]);
    expect(followers).toHaveLength(1);
    expect(followers[0]).toMatchObject({ trades: 2, minDelayBlocks: 3 });
    expect(followers[0]!.address.toLowerCase()).toBe(F);
  });
});

describe("findFunding", () => {
  const chain = (
    firstBlock: number,
    txs: { hash: string; from: string; to: string | null; value: string; type?: string }[],
  ) => {
    const calls: string[] = [];
    const request: RpcRequest = async (method, params) => {
      calls.push(method);
      if (method === "eth_getBalance") return parseInt(params[1] as string, 16) >= firstBlock ? "0x5" : "0x0";
      if (method === "eth_getTransactionCount") return params[1] === "latest" ? "0x7" : "0x0";
      if (method === "eth_getBlockByNumber") {
        expect(parseInt(params[0] as string, 16)).toBe(firstBlock);
        return { transactions: txs };
      }
      if (method === "eth_getCode") return "0x";
      throw new Error(method);
    };
    return { request, calls };
  };

  it("binary-searches the first funded block and finds the direct transfer", async () => {
    const { request } = chain(12_345, [
      { hash: "0x01", from: addr(9), to: addr(8), value: "0x1" },
      { hash: "0x02", from: addr(7), to: ME, value: "0x5" },
    ]);
    const f = await findFunding(request, request, ME, 1_000_000);
    expect(f).toMatchObject({
      block: 12_345,
      tx: "0x02",
      funder: addr(7),
      how: "direct",
      funderNonce: 7,
      funderIsContract: false,
    });
  });

  it("uses the only user transaction in the block, skipping system transactions", async () => {
    const { request } = chain(77, [
      { hash: "0x0a", from: addr(1), to: null, value: "0x0", type: "0x6a" },
      { hash: "0x0b", from: addr(2), to: addr(3), value: "0x0" },
    ]);
    expect(await findFunding(request, request, ME, 1000)).toMatchObject({
      tx: "0x0b",
      funder: addr(2),
      how: "only-tx",
    });
  });

  it("lists candidates when the funding transaction can't be told apart", async () => {
    const { request } = chain(5, [
      { hash: "0x0c", from: addr(1), to: addr(3), value: "0x0" },
      { hash: "0x0d", from: addr(2), to: addr(3), value: "0x0" },
    ]);
    expect(await findFunding(request, request, ME, 1000)).toMatchObject({
      funder: null,
      how: "unknown",
      candidates: ["0x0c", "0x0d"],
    });
  });

  it("returns null for an address that was never funded", async () => {
    const { request } = chain(Infinity, []);
    expect(await findFunding(request, request, ME, 1000)).toBeNull();
  });
});
