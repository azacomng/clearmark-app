import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requestOrigin, requireMerchant } from "@/lib/http";
import { isProvider } from "@/lib/accounting/providers";
import { finishConnect } from "@/lib/accounting/sync";

type Ctx = { params: Promise<{ provider: string }> };

/** The redirect URI the merchant registers on their app. Finishes the sign-in and returns to settings. */
export async function GET(req: Request, ctx: Ctx) {
  const origin = requestOrigin(req);
  const { provider: p } = await ctx.params;
  const back = (q: string) => NextResponse.redirect(`${origin}/app/accounting?provider=${p}&${q}`, 303);
  if (!isProvider(p)) return back("error=" + encodeURIComponent("Unknown accounting system."));
  const jar = await cookies();
  const cookieState = jar.get(`cm_oauth_${p}`)?.value;
  jar.delete({ name: `cm_oauth_${p}`, path: `/api/accounting/${p}` });
  try {
    const m = await requireMerchant();
    await finishConnect(m, p, new URL(req.url).searchParams, `${origin}/api/accounting/${p}/callback`, cookieState);
    return back("connected=1");
  } catch (e) {
    const msg = (e as Error).message === "Unauthorized" || !(e as Error).message ? "Sign in to Clearmark first, then connect again." : (e as Error).message;
    console.error(`[accounting] ${p} connect failed`, (e as Error).message);
    return back("error=" + encodeURIComponent(msg.slice(0, 200)));
  }
}
