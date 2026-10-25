import { describe, expect, it } from "vitest";
import { leakCheck, leakCheckMany, replayRpc } from "../src/index.js";
import { fixtures } from "./helpers.js";

describe("recorded fixtures (offline replay of real Robinhood Chain wallets)", () => {
  it("has the recorded set", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
  });

  for (const f of fixtures) {
    it(`${f.name}: ${f.description}`, async () => {
      const opts = { ...f.options, request: replayRpc(f.rpc) };
      const got =
        f.addresses.length > 1 ? await leakCheckMany(f.addresses, opts) : await leakCheck(f.addresses[0]!, opts);
      expect(JSON.parse(JSON.stringify(got))).toEqual(f.expected);
    });
  }

  it("every finding carries a fix and evidence when found", () => {
    for (const f of fixtures) {
      const reports = (f.expected.reports ?? [f.expected]) as {
        findings: { status: string; fix: string; evidence: unknown[] }[];
      }[];
      for (const r of reports)
        for (const x of r.findings) {
          expect(x.fix.length).toBeGreaterThan(10);
          if (x.status === "found" && x.evidence.length) expect(x.evidence[0]).toHaveProperty("tx");
        }
    }
  });
});
