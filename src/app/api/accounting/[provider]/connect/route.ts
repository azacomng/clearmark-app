import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requestOrigin, requireMerchant } from "@/lib/http";
import { isProvider } from "@/lib/accounting/providers";
import { beginConnect } from "@/lib/accounting/sync";

type Ctx = { params: Promise<{ provider: string }> };

/** Sends the merchant to Xero or Intuit to approve access, with their own app. */
export async function GET(req: Request, ctx: Ctx) {
  const origin = requestOrigin(req);
  const back = (q: string) => NextResponse.redirect(`${origin}/app/accounting?${q}`, 303);
  const { provider: p } = await ctx.params;
  if (!isProvider(p)) return back("error=" + encodeURIComponent("Unknown accounting system."));
  const m = await requireMerchant().catch(() => null);
  if (!m) return NextResponse.redirect(`${origin}/?signin=1`, 303);
  try {
    const { url, state } = await beginConnect(m, p, `${origin}/api/accounting/${p}/callback`);
    (await cookies()).set(`cm_oauth_${p}`, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: `/api/accounting/${p}`,
      maxAge: 15 * 60,
    });
    return NextResponse.redirect(url, 303);
  } catch (e) {
    return back(`provider=${p}&error=` + encodeURIComponent((e as Error).message));
  }
}
