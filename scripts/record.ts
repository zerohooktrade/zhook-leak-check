/**
 * Records a fixture: runs the checks against the public RPCs, captures every JSON-RPC answer, and writes
 * fixtures/<name>.json with the expected report. Tests replay the capture offline.
 *
 *   pnpm record <name> "<description>" <address> [<address> ...]
 */
import { writeFileSync } from "node:fs";
import { HEAD_LAG, leakCheck, leakCheckMany, makeRpcs, recordRpc, type Recording } from "../src/index.js";

const [name, description, ...addresses] = process.argv.slice(2);
if (!name || !description || !addresses.length || !/^[a-z0-9-]+$/.test(name)) {
  console.error('usage: pnpm record <name> "<description>" <address> [<address> ...]');
  process.exit(2);
}
const rpc: Recording = {};
const rpcs = makeRpcs({ wrap: (r) => recordRpc(r, rpc) });
const head = Number(BigInt((await rpcs.read("eth_blockNumber", [])) as string));
const options = { toBlock: head - HEAD_LAG, blocks: 15_000 };
let expected: unknown;
try {
  expected =
    addresses.length > 1
      ? await leakCheckMany(addresses, { ...options, rpcs })
      : await leakCheck(addresses[0]!, { ...options, rpcs });
} catch (e) {
  expected = { error: (e as { code?: string }).code ?? "error", message: (e as Error).message };
}
delete rpc[Object.keys(rpc).find((k) => k.startsWith("eth_blockNumber ")) ?? ""];
const sorted = Object.entries(rpc).sort(([a], [b]) => (a < b ? -1 : 1));
const head2 = JSON.stringify({ name, description, addresses, options, expected }, null, 2).replace(/\n}$/, "");
const body = sorted.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n");
writeFileSync(`fixtures/${name}.json`, `${head2},\n  "rpc": {\n${body}\n  }\n}\n`);
console.log(`fixtures/${name}.json: ${sorted.length} calls`);
