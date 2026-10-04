import { startSession, verifySignIn } from "@/lib/auth";
import { asAddress, body, handle, json, requestOrigin } from "@/lib/http";
import { signInMerchant } from "@/lib/service";
import type { Hex } from "@/lib/types";

export const POST = handle(async (req: Request) => {
  const b = await body<{ address: string; nonce: string; signature: Hex }>(req);
  const a = asAddress(b.address);
  const ok = await verifySignIn(a, String(b.nonce), b.signature, requestOrigin(req));
  if (!ok) return json({ error: "That signature didn't check out. Please try again." }, 401);
  await signInMerchant(a);
  await startSession(a);
  return json({ address: a });
});
