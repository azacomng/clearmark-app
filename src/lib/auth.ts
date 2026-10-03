// Sign in with a wallet: the merchant signs a one-time message, we verify the signature and
// issue an HMAC-signed session cookie. No passwords, no custody, no private keys on the server.

import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { verifyMessage } from "viem";
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

export function signInMessage(address: string, nonce: string, host: string) {
  return [
    `${host} wants you to sign in to Clearmark with your wallet.`,
    "",
    `Address: ${address.toLowerCase()}`,
    "Network: Arc Testnet (5042002)",
    `Nonce: ${nonce}`,
    "",
    "Signing is free and does not send a transaction.",
  ].join("\n");
}

export async function createNonce(address: string): Promise<string> {
  const nonce = randomBytes(12).toString("hex");
  await write((db) => {
    const now = Date.now();
    for (const [k, v] of Object.entries(db.nonces)) if (v.expires < now) delete db.nonces[k];
    db.nonces[nonce] = { address: address.toLowerCase() as Hex, expires: now + 10 * 60_000 };
  });
  return nonce;
}

export async function verifySignIn(address: Hex, nonce: string, signature: Hex, host: string): Promise<boolean> {
  const entry = await write((db) => {
    const e = db.nonces[nonce];
    delete db.nonces[nonce];
    return e;
  });
  if (!entry || entry.expires < Date.now() || entry.address !== address.toLowerCase()) return false;
  return verifyMessage({ address, message: signInMessage(address, nonce, host), signature });
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
