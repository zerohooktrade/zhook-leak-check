import { describe, expect, it } from "vitest";
import {
  addressReuse,
  amountMatch,
  amountMatches,
  fastPairs,
  gasFunder,
  isRound,
  LIMITS,
  roundAmounts,
  runRules,
  sharedFunder,
  significantDigits,
  timing,
  tracker,
  walletLinks,
  type Funding,
} from "../src/index.js";
import { addr, ME, POOL_MANAGER, t, txh, wallet } from "./helpers.js";

const A = addr(0xaa);
const B = addr(0xbb);

describe("address-reuse", () => {
  it("grades by transactions sent", () => {
    expect(addressReuse(wallet({ nonce: 0 }))).toMatchObject({ status: "clear", severity: "none" });
    expect(addressReuse(wallet({ nonce: 3 }))).toMatchObject({ status: "found", severity: "low" });
    expect(addressReuse(wallet({ nonce: 20 }))).toMatchObject({ severity: "medium" });
    expect(addressReuse(wallet({ nonce: 100 }))).toMatchObject({ severity: "high" });
  });

  it("cites outgoing transfers, newest first", () => {
    const out = [t(ME, A, 5n, 1100), t(ME, A, 6n, 1200)];
    const f = addressReuse(wallet({ nonce: 2, outgoing: out }));
    expect(f.evidence.map((e) => e.tx)).toEqual([out[1]!.tx, out[0]!.tx]);
  });
});

describe("amount-match", () => {
  it("pairs an outgoing amount with the latest equal incoming one", () => {
    const inn = [t(A, ME, 1_000_000n, 1100), t(A, ME, 1_000_000n, 1200)];
    const out = [t(ME, B, 1_000_000n, 1300)];
    const pairs = amountMatches(wallet({ incoming: inn, outgoing: out }));
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.inn).toBe(inn[1]);
    expect(pairs[0]!.exact).toBe(true);
    expect(amountMatch(wallet({ incoming: inn, outgoing: out }))).toMatchObject({ status: "found", severity: "high" });
  });

  it(`accepts up to ${LIMITS.matchBps} bps of difference as a near match`, () => {
    const d = wallet({ incoming: [t(A, ME, 1_000_000n, 1100)], outgoing: [t(ME, B, 999_000n, 1101)] });
    expect(amountMatch(d)).toMatchObject({ status: "found", severity: "medium" });
    const far = wallet({ incoming: [t(A, ME, 1_000_000n, 1100)], outgoing: [t(ME, B, 998_000n, 1101)] });
    expect(amountMatch(far).status).toBe("clear");
  });

  it("ignores sells into a pool, earlier outflows and other tokens", () => {
    const d = wallet({
      incoming: [t(A, ME, 500n, 1200), t(A, ME, 700n, 1100, B)],
      outgoing: [t(ME, POOL_MANAGER, 500n, 1300), t(ME, B, 500n, 1150), t(ME, A, 700n, 1300)],
    });
    expect(amountMatches(d)).toEqual([]);
  });

  it("is not-checked when the window is incomplete and nothing matched", () => {
    const d = wallet({ window: { fromBlock: 1, toBlock: 2, complete: false, error: "429" } });
    expect(amountMatch(d).status).toBe("not-checked");
  });
});

describe("round-amounts", () => {
  it("counts significant digits, not decimals", () => {
    expect(significantDigits(0n)).toBe(0);
    expect(significantDigits(1_000_000_000_000_000_000n)).toBe(1);
    expect(significantDigits(2_500_000n)).toBe(2);
    expect(significantDigits(1_037_420_000n)).toBe(6);
    expect(isRound(100_000_000n)).toBe(true);
    expect(isRound(9_000n)).toBe(false);
    expect(isRound(123_000_000n)).toBe(false);
  });

  it("grades by how many round transfers", () => {
    const one = wallet({ incoming: [t(A, ME, 10n ** 20n, 1100)] });
    expect(roundAmounts(one)).toMatchObject({ status: "found", severity: "low" });
    const three = wallet({
      incoming: [t(A, ME, 10n ** 20n, 1100), t(A, ME, 5n * 10n ** 18n, 1101)],
      outgoing: [t(ME, B, 10n ** 6n, 1102)],
    });
    expect(roundAmounts(three).severity).toBe("medium");
    expect(roundAmounts(wallet({ incoming: [t(A, ME, 123_456_789n, 1100)] })).status).toBe("clear");
  });
});

describe("timing", () => {
  it("finds outflows within 20 blocks after an inflow, not in the same block", () => {
    const inn = [t(A, ME, 9n, 1100)];
    const d = wallet({ incoming: inn, outgoing: [t(ME, B, 1n, 1100), t(ME, B, 1n, 1120), t(ME, B, 1n, 1121)] });
    expect(fastPairs(d)).toHaveLength(1);
    expect(timing(d)).toMatchObject({ status: "found", severity: "medium" });
    expect(timing(d).evidence[1]!.note).toContain("20 blocks later");
  });

  it("is high from three fast pairs", () => {
    const d = wallet({
      incoming: [t(A, ME, 9n, 1100)],
      outgoing: [t(ME, B, 1n, 1101), t(ME, B, 1n, 1102), t(ME, B, 1n, 1103)],
    });
    expect(timing(d).severity).toBe("high");
  });
});

describe("gas-funder", () => {
  const funding = (over: Partial<Funding>): Funding => ({
    block: 500,
    tx: txh(),
    funder: A,
    how: "direct",
    candidates: [],
    funderNonce: 3,
    funderIsContract: false,
    ...over,
  });

  it("is high for a personal wallet, low for a busy one, medium for a contract", () => {
    expect(gasFunder(wallet({ funding: funding({}) }))).toMatchObject({ status: "found", severity: "high" });
    expect(gasFunder(wallet({ funding: funding({ funderNonce: 5000 }) })).severity).toBe("low");
    expect(gasFunder(wallet({ funding: funding({ funderIsContract: true }) })).severity).toBe("medium");
  });

  it("reports an unresolved funding block with its transactions", () => {
    const c = [txh(), txh()];
    const f = gasFunder(wallet({ funding: funding({ funder: null, tx: null, how: "unknown", candidates: c }) }));
    expect(f).toMatchObject({ status: "found", severity: "low" });
    expect(f.evidence.map((e) => e.tx)).toEqual(c);
  });

  it("is clear when never funded and not-checked when skipped", () => {
    expect(gasFunder(wallet({ funding: null })).status).toBe("clear");
    expect(gasFunder(wallet({ funding: undefined, kind: "contract" }))).toMatchObject({ status: "not-checked" });
    expect(gasFunder(wallet({ funding: undefined, fundingError: "archive down" })).detail).toBe("archive down");
  });
});

describe("shared-funder", () => {
  it("flags a sender that paid other addresses", () => {
    const toWallet = [t(A, ME, 10n, 1100)];
    const toOthers = [t(A, B, 10n, 1101), t(A, addr(0xcc), 10n, 1102)];
    const d = wallet({ senders: [{ sender: A, isContract: false, toWallet, toOthers, complete: true }] });
    const f = sharedFunder(d);
    expect(f).toMatchObject({ status: "found", severity: "medium" });
    expect(f.detail).toContain("paid 2 other addresses");
    expect(f.evidence.map((e) => e.tx)).toContain(toWallet[0]!.tx);
  });

  it("is low for contracts and busy distributors", () => {
    const many = Array.from({ length: LIMITS.busyRecipients }, (_, i) => t(A, addr(0x1000 + i), 1n, 1101));
    const busy = wallet({ senders: [{ sender: A, isContract: false, toWallet: [], toOthers: many, complete: true }] });
    expect(sharedFunder(busy).severity).toBe("low");
    const contract = wallet({
      senders: [{ sender: A, isContract: true, toWallet: [], toOthers: [t(A, B, 1n, 1)], complete: true }],
    });
    expect(sharedFunder(contract).severity).toBe("low");
  });

  it("is clear without other recipients and not-checked without data", () => {
    expect(sharedFunder(wallet({ senders: [] })).status).toBe("clear");
    expect(sharedFunder(wallet({ senders: null })).status).toBe("not-checked");
  });
});

describe("tracker", () => {
  const trade = (block: number) => ({ token: A, block, tx: txh(), value: 1n, buyersAfter: 3, complete: true });

  it("is clear with no trades or no repeat follower", () => {
    expect(tracker(wallet()).status).toBe("clear");
    expect(tracker(wallet({ tracker: { trades: [trade(1100)], followers: [], complete: true } })).status).toBe("clear");
    expect(tracker(wallet({ tracker: { trades: [trade(1100)], followers: [], complete: false } })).status).toBe(
      "not-checked",
    );
    expect(tracker(wallet({ tracker: null })).status).toBe("not-checked");
  });

  it("grades followers", () => {
    const f1 = { address: B, trades: 2, tokens: [A], minDelayBlocks: 3, txs: [txh(), txh()] };
    const one = wallet({ tracker: { trades: [trade(1100), trade(1200)], followers: [f1], complete: true } });
    expect(tracker(one)).toMatchObject({ status: "found", severity: "medium" });
    expect(tracker(one).evidence[0]!.tx).toBe(f1.txs[0]);
    const strong = wallet({ tracker: { trades: [trade(1100)], followers: [{ ...f1, trades: 3 }], complete: true } });
    expect(tracker(strong).severity).toBe("high");
  });
});

describe("wallet-links", () => {
  it("finds direct transfers, a shared gas funder and a shared token sender", () => {
    const w1 = wallet({ address: ME, outgoing: [t(ME, B, 5n, 1100)], incoming: [t(addr(0xdd), ME, 1n, 1000)] });
    const w2 = wallet({ address: B, incoming: [t(addr(0xdd), B, 1n, 1001)] });
    const f = walletLinks([w1, w2]);
    expect(f).toMatchObject({ status: "found", severity: "high" });
    expect(f.detail).toContain("1 direct transfer");
    expect(f.detail).toContain("sent tokens to 2 of the wallets");
  });

  it("treats a shared gas funder alone as high", () => {
    const funding = {
      block: 1,
      tx: txh(),
      funder: A,
      how: "direct" as const,
      candidates: [],
      funderNonce: 1,
      funderIsContract: false,
    };
    const f = walletLinks([wallet({ funding }), wallet({ address: B, funding: { ...funding, tx: txh() } })]);
    expect(f.severity).toBe("high");
    expect(f.evidence).toHaveLength(2);
  });

  it("is clear for unrelated wallets", () => {
    expect(walletLinks([wallet(), wallet({ address: B })]).status).toBe("clear");
  });
});

describe("runRules", () => {
  it("returns the seven rules in order", () => {
    expect(runRules(wallet()).map((f) => f.id)).toEqual([
      "address-reuse",
      "amount-match",
      "round-amounts",
      "timing",
      "gas-funder",
      "shared-funder",
      "tracker",
    ]);
  });
});
