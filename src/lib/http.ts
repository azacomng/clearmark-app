import "server-only";
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { sessionAddress } from "./auth";
import { LedgerError } from "./ledger";
import type { Hex } from "./types";

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });

export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof LedgerError) return json({ error: e.message }, e.status);
      if (e instanceof Unauthorized) return json({ error: "Sign in with your wallet first." }, 401);
      console.error(e);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  };
}

class Unauthorized extends Error {}

export async function requireMerchant(): Promise<Hex> {
  const a = await sessionAddress();
  if (!a) throw new Unauthorized();
  return a;
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new LedgerError("Invalid request body.");
  }
}

export function asAddress(v: unknown): Hex {
  if (typeof v !== "string" || !isAddress(v)) throw new LedgerError("Invalid wallet address.");
  return v.toLowerCase() as Hex;
}

export function asTxHash(v: unknown): Hex {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new LedgerError("Invalid transaction hash.");
  return v.toLowerCase() as Hex;
}

/**
 * The site's origin for this request. The host comes from the request itself (on Vercel the platform
 * routes by it, so it can't name another site); only the scheme is taken from the proxy's header.
 */
export function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https" ? "https" : url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
}
