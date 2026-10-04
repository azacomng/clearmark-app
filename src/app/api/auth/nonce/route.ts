import { createSignIn } from "@/lib/auth";
import { asAddress, body, handle, json, requestOrigin } from "@/lib/http";

export const POST = handle(async (req: Request) => {
  const { address } = await body<{ address: string }>(req);
  return json(await createSignIn(asAddress(address), requestOrigin(req)));
});
