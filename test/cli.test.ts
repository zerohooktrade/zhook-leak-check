import { describe, expect, it } from "vitest";
import { replayRpc } from "../src/index.js";
import { run, USAGE, VERSION } from "../src/run.js";
import { fixture } from "./helpers.js";

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

describe("cli", () => {
  it("prints help and version", async () => {
    const a = io();
    expect(await run(["-h"], a.io)).toBe(0);
    expect(a.out[0]).toBe(USAGE);
    const b = io();
    expect(await run(["-v"], b.io)).toBe(0);
    expect(b.out[0]).toBe(VERSION);
    expect(await run([], io().io)).toBe(2);
  });

  it("rejects bad usage with exit code 2", async () => {
    for (const argv of [
      ["0x12"],
      ["--json"],
      ["0x" + "1".repeat(40), "--blocks", "x"],
      ["0x" + "1".repeat(40), "--blocks", "0"],
      ["0x" + "1".repeat(40), "--nope"],
      ["0x" + "1".repeat(40), "--with", "abc"],
    ]) {
      const a = io();
      expect(await run(argv, a.io)).toBe(2);
      expect(a.err.join("\n")).toContain("Usage");
    }
  });

  it("prints a JSON report from a replayed fixture", async () => {
    const f = fixture("heavy-reuse");
    const a = io();
    const code = await run(
      [f.addresses[0]!, "--json", "--blocks", String(f.options.blocks), "--to-block", String(f.options.toBlock)],
      a.io,
      {
        request: replayRpc(f.rpc),
      },
    );
    expect(JSON.parse(a.out[0]!)).toEqual(f.expected);
    expect(code).toBe(1);
  });

  it("prints a readable report and exits 0 without a high finding", async () => {
    const f = fixture("eip7702-round-amounts");
    const a = io();
    const code = await run([f.addresses[0]!, "--to-block", String(f.options.toBlock)], a.io, {
      request: replayRpc(f.rpc),
    });
    expect(code).toBe(0);
    expect(a.out[0]).toContain("EIP-7702 wallet");
    expect(a.out[0]).toContain("Fix:");
  });

  it("checks several wallets with --with", async () => {
    const f = fixture("two-wallets");
    const a = io();
    await run([f.addresses[0]!, "--with", f.addresses[1]!, "--json", "--to-block", String(f.options.toBlock)], a.io, {
      request: replayRpc(f.rpc),
    });
    expect(JSON.parse(a.out[0]!)).toEqual(f.expected);
  });

  it("exits 3 when the RPC fails", async () => {
    const a = io();
    const code = await run(["0x" + "1".repeat(40)], a.io, {
      request: async () => {
        throw new Error("offline");
      },
    });
    expect(code).toBe(3);
  });
});
