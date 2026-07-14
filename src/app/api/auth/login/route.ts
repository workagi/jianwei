import { NextResponse } from "next/server";
import { ADMIN_COOKIE, getAdminToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * 用 ADMIN_API_TOKEN 换取 httpOnly cookie，供 /admin 页面访问使用。
 * 写操作 API 仍直接走 `Authorization: Bearer`，不走 cookie。
 */
export async function POST(req: Request) {
  const expected = getAdminToken();
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "未配置 ADMIN_API_TOKEN，无需登录" },
      { status: 400 },
    );
  }

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "无效的请求体" }, { status: 400 });
  }

  if (body.token !== expected) {
    return NextResponse.json({ ok: false, error: "令牌错误" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, expected, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
