import { createNonce, signInMessage } from "@/lib/auth";
import { asAddress, body, handle, json } from "@/lib/http";

export const POST = handle(async (req: Request) => {
  const { address } = await body<{ address: string }>(req);
  const a = asAddress(address);
  const nonce = await createNonce(a);
  return json({ nonce, message: signInMessage(a, nonce, new URL(req.url).host) });
});
