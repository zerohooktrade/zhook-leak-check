/**
 * Live check against a real RPC. Skipped unless RPC_URL is set, e.g.
 *   RPC_URL=https://robinhood.drpc.org pnpm test:live
 * RPC_URL is used for reads and the first-funding search; logs still come from the public log RPC unless
 * LOG_RPC_URL is set. A past window never changes, so the result must equal the recorded fixture.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_RPCS, leakCheck } from "../src/index.js";
import { fixture } from "./helpers.js";

const url = process.env.RPC_URL;

describe.skipIf(!url)("live (RPC_URL)", () => {
  it("re-checks a recorded wallet from the chain", { timeout: 300_000 }, async () => {
    const f = fixture("heavy-reuse");
    const r = await leakCheck(f.addresses[0]!, {
      ...f.options,
      rpcUrls: [url!, ...DEFAULT_RPCS.read],
      archiveUrls: [url!, ...DEFAULT_RPCS.archive],
      logUrls: process.env.LOG_RPC_URL ? [process.env.LOG_RPC_URL] : DEFAULT_RPCS.logs,
    });
    const e = f.expected as { window: unknown; findings: { id: string; status: string; severity: string }[] };
    expect(r.window).toEqual(e.window);
    const pick = (fs: { id: string; status: string; severity: string }[]) =>
      fs
        .filter((x) => !["address-reuse", "gas-funder"].includes(x.id))
        .map(({ id, status, severity }) => ({ id, status, severity }));
    // Nonce and the funder's activity grow over time; the window-bound rules must not change.
    expect(pick(r.findings)).toEqual(pick(e.findings));
  });
});
