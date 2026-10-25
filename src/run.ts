import pkg from "../package.json" with { type: "json" };
import { LeakCheckError, leakCheck, leakCheckMany, MAX_BLOCKS, type CheckOptions } from "./check.js";
import { formatMulti, formatReport } from "./format.js";

export const VERSION: string = pkg.version;

export const USAGE = `zhook-leak-check ${VERSION}: what links a Robinhood Chain wallet to its trades

Usage
  zhook-leak-check <address> [options]

Options
  --json                 print the report as JSON
  --with <address>       also check this wallet and the links between them (repeatable)
  --blocks <n>           window size in blocks (default 15000, ~26 min; max ${MAX_BLOCKS})
  --to-block <n>         last block of the window (default: latest)
  --no-funding           skip the first-funding search (archive RPC)
  --no-tracker           skip the tracker check
  --rpc <url>            RPC for latest-block reads (repeatable)
  --archive-rpc <url>    RPC that serves past blocks (repeatable)
  --log-rpc <url>        RPC for eth_getLogs (repeatable)
  --span <n>             blocks per eth_getLogs call (default 1000)
  --verbose              print details of clear findings too
  -v, --version          print the version
  -h, --help             print this help

Exit codes: 0 = nothing high found, 1 = a high-severity link was found, 2 = bad usage, 3 = RPC failure.
Docs: https://docs.zerohook.trade`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** The CLI without process globals. Returns the exit code. */
export async function run(argv: string[], io: Io, base: CheckOptions = {}): Promise<number> {
  const args = [...argv];
  if (!args.length || args.includes("-h") || args.includes("--help")) {
    io.out(USAGE);
    return args.length ? 0 : 2;
  }
  if (args.includes("-v") || args.includes("--version")) {
    io.out(VERSION);
    return 0;
  }
  const opts: CheckOptions = { ...base };
  const addresses: string[] = [];
  const rpcUrls: string[] = [];
  const archiveUrls: string[] = [];
  const logUrls: string[] = [];
  let json = false;
  let verbose = false;
  try {
    while (args.length) {
      const a = args.shift()!;
      const val = () => {
        const v = args.shift();
        if (!v) throw new Error(`${a} needs a value`);
        return v;
      };
      const int = () => {
        const v = val();
        if (!/^\d+$/.test(v)) throw new Error(`${a} expects a whole number, got ${v}`);
        return Number(v);
      };
      if (a === "--json") json = true;
      else if (a === "--verbose") verbose = true;
      else if (a === "--no-funding") opts.funding = false;
      else if (a === "--no-tracker") opts.tracker = false;
      else if (a === "--with") addresses.push(val());
      else if (a === "--blocks") opts.blocks = int();
      else if (a === "--to-block") opts.toBlock = int();
      else if (a === "--span") opts.logs = { ...opts.logs, span: Math.max(1, int()) };
      else if (a === "--rpc") rpcUrls.push(val());
      else if (a === "--archive-rpc") archiveUrls.push(val());
      else if (a === "--log-rpc") logUrls.push(val());
      else if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
      else addresses.unshift(a);
    }
    if (!addresses.length) throw new Error("Give a wallet address");
    for (const a of addresses) if (!isAddr(a)) throw new Error(`Not an address: ${a}`);
    if (opts.blocks !== undefined && (opts.blocks < 1 || opts.blocks > MAX_BLOCKS))
      throw new Error(`--blocks must be from 1 to ${MAX_BLOCKS}`);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (rpcUrls.length) opts.rpcUrls = rpcUrls;
  if (archiveUrls.length) opts.archiveUrls = archiveUrls;
  if (logUrls.length) opts.logUrls = logUrls;
  try {
    if (new Set(addresses.map((a) => a.toLowerCase())).size > 1) {
      const m = await leakCheckMany(addresses, opts);
      io.out(json ? JSON.stringify(m, null, 2) : formatMulti(m, verbose));
      const high =
        m.reports.some((r) => r.summary.high > 0) || (m.links.status === "found" && m.links.severity === "high");
      return high ? 1 : 0;
    }
    const r = await leakCheck(addresses[0]!, opts);
    io.out(json ? JSON.stringify(r, null, 2) : formatReport(r, verbose));
    return r.summary.high > 0 ? 1 : 0;
  } catch (e) {
    const code = e instanceof LeakCheckError ? e.code : "error";
    if (json) io.out(JSON.stringify({ error: code, message: (e as Error).message }, null, 2));
    else io.err((e as Error).message);
    return code === "bad-input" ? 2 : 3;
  }
}
