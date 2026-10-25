import { keccak256, stringToHex } from "viem";
import { DEFAULT_RPCS, LOG_SPAN, type Address, type Hex } from "./chain.js";

/** One JSON-RPC call. Every network read in this package goes through a function of this shape. */
export type RpcRequest = (method: string, params: unknown[]) => Promise<unknown>;

/** Error carrying the JSON-RPC error code, so viem can tell a revert from a transport failure. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface HttpRpcOptions {
  timeoutMs?: number;
  /** Extra attempts per URL on HTTP 429 / 5xx / network errors (default 2). */
  retries?: number;
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plain JSON-RPC over fetch. URLs are tried in order; rate limits and network errors are retried with a short
 * backoff. A revert is final. Any other JSON-RPC error (a node that refuses old blocks, an unsupported method) moves
 * on to the next URL, and the last one is thrown.
 */
export function httpRpc(urls: readonly string[], opts: HttpRpcOptions = {}): RpcRequest {
  if (!urls.length) throw new Error("at least one RPC URL is required");
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const retries = opts.retries ?? 2;
  const doFetch = opts.fetch ?? fetch;
  let id = 0;
  return async (method, params) => {
    const errors: string[] = [];
    for (const url of urls) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        let res: Response;
        try {
          res = await doFetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          errors.push(`${host(url)}: ${(e as Error).message}`);
          if (attempt < retries) await sleep(300 * 2 ** attempt + Math.random() * 200);
          continue;
        }
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          errors.push(`${host(url)}: HTTP ${res.status}`);
          if (attempt < retries) await sleep(400 * 2 ** attempt + Math.random() * 300);
          continue;
        }
        let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
        try {
          body = JSON.parse(text);
        } catch {
          errors.push(`${host(url)}: HTTP ${res.status} ${text.slice(0, 80)}`);
          break;
        }
        if (body.error) {
          const msg = body.error.message ?? "rpc error";
          // Some public nodes report rate limits as JSON-RPC errors.
          if (/rate|limit|too many/i.test(msg) && attempt < retries) {
            errors.push(`${host(url)}: ${msg}`);
            await sleep(400 * 2 ** attempt + Math.random() * 300);
            continue;
          }
          const err = new RpcError(msg, body.error.code ?? -32000, body.error.data);
          if (err.code === 3 || /revert/i.test(msg) || url === urls[urls.length - 1]) throw err;
          errors.push(`${host(url)}: ${msg}`);
          break;
        }
        return body.result;
      }
    }
    throw new Error(`${method} failed on every RPC: ${errors.join(" | ").slice(0, 400)}`);
  };
}

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

/** A recorded call: the result, or the JSON-RPC error it returned. */
export type RecordedCall = { result: unknown } | { error: { message: string; code: number; data?: unknown } };
export type Recording = Record<string, RecordedCall>;

/** Stable key of a call: the method plus keccak256 of its JSON parameters. */
export const callKey = (method: string, params: unknown[]) =>
  `${method} ${keccak256(stringToHex(JSON.stringify(params))).slice(2, 34)}`;

/** Wraps a requester and writes every answer into `store`, so a run can be replayed offline. */
export function recordRpc(inner: RpcRequest, store: Recording): RpcRequest {
  return async (method, params) => {
    const key = callKey(method, params);
    try {
      const result = await inner(method, params);
      store[key] = { result };
      return result;
    } catch (e) {
      if (e instanceof RpcError) store[key] = { error: { message: e.message, code: e.code, data: e.data } };
      throw e;
    }
  };
}

/** Answers calls from a recording only. A call that was not recorded throws, so a replay never touches the network. */
export function replayRpc(store: Recording): RpcRequest {
  return async (method, params) => {
    const key = callKey(method, params);
    const hit = store[key];
    if (!hit) throw new Error(`not in the recording: ${method} ${JSON.stringify(params).slice(0, 160)}`);
    if ("error" in hit) throw new RpcError(hit.error.message, hit.error.code, hit.error.data);
    return structuredClone(hit.result);
  };
}

/** A raw eth_getLogs entry. */
export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

export interface LogFilter {
  address?: Address;
  topics: (Hex | Hex[] | null)[];
}

export interface ChunkedLogs {
  logs: RawLog[];
  /** Every range was answered. */
  complete: boolean;
  error: string | null;
}

export interface GetLogsOptions {
  /** Blocks per call (default 1,000, the public thirdweb limit). */
  span?: number;
  /** Calls in flight (default 2: public log RPCs rate-limit bursts). */
  concurrency?: number;
  /** Smallest range a failing range is split down to (default 100). */
  minSpan?: number;
}

const hex = (n: number) => `0x${n.toString(16)}` as Hex;

/**
 * eth_getLogs over [from, to] in fixed ranges. A failing range is split in half down to `minSpan` before it is given
 * up; then `complete` is false and the error is kept. Logs come back ordered by block and log index.
 */
export async function getLogsChunked(
  request: RpcRequest,
  filter: LogFilter,
  from: number,
  to: number,
  opts: GetLogsOptions = {},
): Promise<ChunkedLogs> {
  const span = opts.span ?? LOG_SPAN;
  const minSpan = opts.minSpan ?? 100;
  if (to < from) return { logs: [], complete: true, error: null };
  const queue: [number, number][] = [];
  for (let a = from; a <= to; a += span) queue.push([a, Math.min(to, a + span - 1)]);
  const logs: RawLog[] = [];
  let complete = true;
  let error: string | null = null;
  const one = async ([a, b]: [number, number]): Promise<void> => {
    try {
      const r = (await request("eth_getLogs", [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }])) as RawLog[];
      logs.push(...r);
    } catch (e) {
      if (b - a + 1 > minSpan) {
        const mid = Math.floor((a + b) / 2);
        await one([a, mid]);
        await one([mid + 1, b]);
      } else {
        complete = false;
        error = String((e as Error).message ?? "log query failed")
          .split("\n")[0]!
          .slice(0, 160);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, async () => {
      for (let r = queue.shift(); r; r = queue.shift()) await one(r);
    }),
  );
  logs.sort(
    (x, y) =>
      parseInt(x.blockNumber, 16) - parseInt(y.blockNumber, 16) || parseInt(x.logIndex, 16) - parseInt(y.logIndex, 16),
  );
  return { logs, complete, error };
}

/** The three transports the checks read through. */
export interface Rpcs {
  read: RpcRequest;
  archive: RpcRequest;
  logs: RpcRequest;
}

export interface RpcOptions {
  rpcUrls?: readonly string[];
  archiveUrls?: readonly string[];
  logUrls?: readonly string[];
  /** Replaces all three transports (tests, offline replay). */
  request?: RpcRequest;
  /** Wraps each HTTP transport, e.g. with recordRpc to capture a run. */
  wrap?: (request: RpcRequest) => RpcRequest;
}

export function makeRpcs(opts: RpcOptions = {}): Rpcs {
  if (opts.request) return { read: opts.request, archive: opts.request, logs: opts.request };
  const wrap = opts.wrap ?? ((r: RpcRequest) => r);
  return {
    read: wrap(httpRpc(opts.rpcUrls ?? DEFAULT_RPCS.read)),
    archive: wrap(httpRpc(opts.archiveUrls ?? DEFAULT_RPCS.archive)),
    logs: wrap(httpRpc(opts.logUrls ?? DEFAULT_RPCS.logs, { retries: 3 })),
  };
}
