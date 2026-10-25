import { describe, expect, it } from "vitest";
import { callKey, httpRpc, recordRpc, replayRpc, RpcError, type Recording } from "../src/index.js";

const reply = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("httpRpc", () => {
  it("retries rate limits, then falls back to the next URL", async () => {
    const seen: string[] = [];
    const rpc = httpRpc(["https://a.example", "https://b.example"], {
      retries: 1,
      fetch: async (url) => {
        seen.push(String(url));
        return String(url).includes("a.")
          ? reply(429, "slow down")
          : reply(200, { jsonrpc: "2.0", id: 1, result: "0x1" });
      },
    });
    expect(await rpc("eth_blockNumber", [])).toBe("0x1");
    expect(seen).toEqual(["https://a.example", "https://a.example", "https://b.example"]);
  });

  it("treats a JSON-RPC error as final", async () => {
    let calls = 0;
    const rpc = httpRpc(["https://a.example", "https://b.example"], {
      fetch: async () => {
        calls++;
        return reply(200, { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } });
      },
    });
    await expect(rpc("eth_call", [])).rejects.toMatchObject({ name: "RpcError", code: 3 });
    expect(calls).toBe(1);
  });

  it("moves on to the next URL when a node refuses the call", async () => {
    const rpc = httpRpc(["https://a.example", "https://b.example"], {
      fetch: async (url) =>
        String(url).includes("a.")
          ? reply(200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "archive requests need a token" } })
          : reply(200, { jsonrpc: "2.0", id: 1, result: "0x2" }),
    });
    expect(await rpc("eth_getBalance", ["0x", "0x1"])).toBe("0x2");
  });

  it("reports every URL when all fail", async () => {
    const rpc = httpRpc(["https://a.example"], { retries: 0, fetch: async () => reply(503, "down") });
    await expect(rpc("eth_chainId", [])).rejects.toThrow(/a\.example: HTTP 503/);
  });

  it("needs a URL", () => {
    expect(() => httpRpc([])).toThrow();
  });
});

describe("record and replay", () => {
  it("replays results and errors without a network", async () => {
    const store: Recording = {};
    const inner = async (method: string) => {
      if (method === "eth_call") throw new RpcError("execution reverted", 3);
      return "0x10";
    };
    const rec = recordRpc(inner, store);
    expect(await rec("eth_blockNumber", [])).toBe("0x10");
    await expect(rec("eth_call", [{ to: "0x" }])).rejects.toBeInstanceOf(RpcError);
    expect(Object.keys(store)).toEqual([callKey("eth_blockNumber", []), callKey("eth_call", [{ to: "0x" }])]);

    const replay = replayRpc(store);
    expect(await replay("eth_blockNumber", [])).toBe("0x10");
    await expect(replay("eth_call", [{ to: "0x" }])).rejects.toMatchObject({ code: 3 });
    await expect(replay("eth_chainId", [])).rejects.toThrow(/not in the recording/);
  });

  it("keys calls by method and parameters", () => {
    expect(callKey("eth_call", [1])).not.toBe(callKey("eth_call", [2]));
    expect(callKey("eth_call", [1])).toMatch(/^eth_call [0-9a-f]{32}$/);
  });
});
