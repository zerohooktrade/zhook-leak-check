import { explorerTx } from "./chain.js";
import type { LeakReport, MultiReport } from "./check.js";
import type { Finding } from "./rules.js";

const MARK: Record<string, string> = { high: "HIGH", medium: "MED ", low: "LOW ", none: "    " };

function finding(f: Finding, verbose: boolean): string[] {
  const tag = f.status === "found" ? MARK[f.severity] : f.status === "clear" ? " ok " : " -- ";
  const lines = [`[${tag}] ${f.title}`];
  if (f.status !== "clear" || verbose) lines.push(`       ${f.detail}`);
  if (f.status === "found") {
    for (const e of f.evidence) lines.push(`       · ${e.note}: ${explorerTx(e.tx)}`);
    lines.push(`       Fix: ${f.fix}`);
  }
  return lines;
}

/** Plain-text report, as printed by the CLI. */
export function formatReport(r: LeakReport, verbose = false): string {
  const s = r.summary;
  const lines = [
    `Leak check · ${r.spec}`,
    `${r.address} (${r.kind === "eoa" ? "plain wallet" : r.kind === "eip7702" ? "EIP-7702 wallet" : "contract"}, ${r.nonce.toLocaleString("en-US")} transactions sent)`,
    `Window: blocks ${r.window.fromBlock.toLocaleString("en-US")}–${r.window.toBlock.toLocaleString("en-US")} (~${r.window.approxMinutes} min)${r.window.complete ? "" : ` · incomplete: ${r.window.error ?? "some log ranges failed"}`}`,
    `Found: ${s.high} high, ${s.medium} medium, ${s.low} low · ${s.clear} clear · ${s.notChecked} not checked`,
    "",
  ];
  for (const f of r.findings) lines.push(...finding(f, verbose));
  return lines.join("\n");
}

export function formatMulti(m: MultiReport, verbose = false): string {
  return [
    ...m.reports.map((r) => formatReport(r, verbose)),
    "Links between the wallets",
    ...finding(m.links, true),
  ].join("\n\n");
}
