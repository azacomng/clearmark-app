// Encrypts secrets Clearmark has to keep (accounting app secrets and OAuth tokens) before they go
// into the store, with AES-256-GCM. The key comes from CLEARMARK_SECRET_KEY, else SESSION_SECRET,
// else the generated secret in the store itself (fine for local use, weakest on a server).

import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Db } from "./types";

export function sealKey(db: Pick<Db, "secret">): Buffer {
  const material = process.env.CLEARMARK_SECRET_KEY || process.env.SESSION_SECRET || db.secret;
  if (!material) throw new Error("No key to protect stored secrets. Set CLEARMARK_SECRET_KEY.");
  return createHash("sha256").update(`clearmark:seal:v1:${material}`).digest();
}

export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export class SealError extends Error {}

export function unseal(sealed: string, key: Buffer): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new SealError("Stored secret is in an unknown format.");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    // The key changed (CLEARMARK_SECRET_KEY or SESSION_SECRET was replaced) since this was saved.
    throw new SealError("Stored keys can't be read any more because the server's secret key changed. Enter the app keys again and reconnect.");
  }
}
