// v1 storage: a single JSON file, written atomically, with an in-process write lock.
// Good enough for a pilot on one server. The rest of the app only talks to
// read() and write(), so swapping in Postgres later touches this file alone.

import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Db } from "./types";

// Where the data lives:
//   - Upstash Redis (one JSON document) when its REST credentials are set. Use this on Vercel, whose
//     functions have a read-only filesystem and don't share disk between instances.
//   - Otherwise a JSON file. On Vercel without Redis that file goes in /tmp, so the app runs but
//     data is temporary.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
// Mainnet data lives under its own key, so nothing from the earlier testnet pilot (kept under
// "clearmark:db") mixes with real payments.
const REDIS_KEY = process.env.CLEARMARK_REDIS_KEY || "clearmark:mainnet:db";
const FILE = path.resolve(
  /*turbopackIgnore: true*/ process.env.CLEARMARK_DATA_FILE || (process.env.VERCEL ? "/tmp/clearmark-mainnet.json" : "./data/clearmark-mainnet.json"),
);

const empty = (): Db => ({ version: 1, merchants: {}, invoices: {}, payments: {}, refunds: {}, nonces: {} });

let chain: Promise<unknown> = Promise.resolve();

async function redis(cmd: string[]): Promise<unknown> {
  const res = await fetch(REDIS_URL!, {
    method: "POST",
    headers: { authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  const out = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!res.ok || out.error) throw new Error(`Storage error: ${out.error ?? res.status}`);
  return out.result;
}

async function load(): Promise<Db> {
  if (REDIS_URL && REDIS_TOKEN) {
    const raw = (await redis(["GET", REDIS_KEY])) as string | null;
    return raw ? (JSON.parse(raw) as Db) : empty();
  }
  try {
    return JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ FILE, "utf8")) as Db;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw e;
  }
}

async function save(db: Db) {
  if (REDIS_URL && REDIS_TOKEN) {
    await redis(["SET", REDIS_KEY, JSON.stringify(db)]);
    return;
  }
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, FILE);
}

export async function read(): Promise<Db> {
  await chain.catch(() => {});
  return load();
}

/** Run a read-modify-write transaction. Writes are serialized. */
export function write<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
  const run = chain.catch(() => {}).then(async () => {
    const db = await load();
    const result = await fn(db);
    await save(db);
    return result;
  });
  chain = run;
  return run;
}

export function newId(prefix = "", bytes = 8): string {
  // base36 keeps ids URL friendly and hard to guess
  const n = BigInt("0x" + randomBytes(bytes).toString("hex"));
  return prefix + n.toString(36);
}
