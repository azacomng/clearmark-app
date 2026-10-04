// Sign in with a wallet: the merchant signs a one-time Sign-In with Ethereum (EIP-4361) message,
// we verify the signature and issue an HMAC-signed session cookie. No passwords, no custody, no
// private keys on the server. Wallets recognise the standard format and check that its domain
// matches the site asking, so the sign-in screen shows a verified request instead of raw text.

import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getAddress, verifyMessage } from "viem";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { ARC_TESTNET_CHAIN_ID } from "./arc";
import { read, write } from "./store";
import type { Hex } from "./types";

const COOKIE = "cm_session";
const SESSION_DAYS = 7;

async function secret(): Promise<string> {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const db = await read();
  if (db.secret) return db.secret;
  return write((d) => (d.secret ??= randomBytes(32).toString("hex")));
}

const sign = (payload: string, key: string) => createHmac("sha256", key).update(payload).digest("base64url");

const NONCE_TTL_MS = 10 * 60_000;

/** The EIP-4361 message for this sign-in. `origin` is the site's own URL, e.g. https://clearmark.app */
export function signInMessage(address: string, nonce: string, origin: string, issuedAt: Date) {
  const url = new URL(origin);
  return createSiweMessage({
    domain: url.host,
    address: getAddress(address),
    statement: "Sign in to Clearmark. This is free and does not send a transaction.",
    uri: url.origin,
    version: "1",
    chainId: ARC_TESTNET_CHAIN_ID,
    nonce,
    issuedAt,
    expirationTime: new Date(issuedAt.getTime() + NONCE_TTL_MS),
  });
}

/** Create a one-time challenge and return the message to sign. */
export async function createSignIn(address: string, origin: string): Promise<{ nonce: string; message: string }> {
  const nonce = randomBytes(12).toString("hex");
  const now = new Date();
  const message = signInMessage(address, nonce, origin, now);
  await write((db) => {
    for (const [k, v] of Object.entries(db.nonces)) if (v.expires < now.getTime()) delete db.nonces[k];
    db.nonces[nonce] = { address: address.toLowerCase() as Hex, expires: now.getTime() + NONCE_TTL_MS, message };
  });
  return { nonce, message };
}

export async function verifySignIn(address: Hex, nonce: string, signature: Hex, origin: string): Promise<boolean> {
  const entry = await write((db) => {
    const e = db.nonces[nonce];
    delete db.nonces[nonce];
    return e;
  });
  if (!entry?.message || entry.expires < Date.now() || entry.address !== address.toLowerCase()) return false;
  // The challenge must be for this site, this wallet and this nonce, and still be in date.
  const fields = parseSiweMessage(entry.message);
  if (!validateSiweMessage({ message: fields, address, domain: new URL(origin).host, nonce })) return false;
  return verifyMessage({ address, message: entry.message, signature });
}

export async function startSession(address: Hex) {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${address.toLowerCase()}.${exp}`;
  const value = `${payload}.${sign(payload, await secret())}`;
  (await cookies()).set(COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

/** The signed-in merchant's address, or null. */
export async function sessionAddress(): Promise<Hex | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const i = raw.lastIndexOf(".");
  const payload = raw.slice(0, i);
  const mac = raw.slice(i + 1);
  const expected = sign(payload, await secret());
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const [address, exp] = payload.split(".");
  if (Number(exp) < Date.now()) return null;
  return address as Hex;
}
