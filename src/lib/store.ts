// v1 storage: a single JSON file, written atomically, with an in-process write lock.
// Good enough for a testnet pilot on one server. The rest of the app only talks to
// read() and write(), so swapping in Postgres later touches this file alone.

import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Db } from "./types";

const FILE = path.resolve(/*turbopackIgnore: true*/ process.env.CLEARMARK_DATA_FILE || "./data/clearmark.json");

const empty = (): Db => ({ version: 1, merchants: {}, invoices: {}, payments: {}, refunds: {}, nonces: {} });

let chain: Promise<unknown> = Promise.resolve();

async function load(): Promise<Db> {
  try {
    return JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ FILE, "utf8")) as Db;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw e;
  }
}

async function save(db: Db) {
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
