import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  adminCredentialsMatch,
  adminSessionCookieValue,
  effectiveAdminSessionSecret,
  isAdminAuthConfigured,
} from "@/lib/auth";
import { checkLoginRateLimit, clearLoginAttempts, recordLoginAttempt } from "@/db/queries";

export const dynamic = "force-dynamic";

function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "local";
}


/** 账号密码换取 httpOnly 管理会话；API token 继续只供程序调用。 */
export async function POST(req: Request) {
  if (!isAdminAuthConfigured()) {
    return NextResponse.json(
      { ok: false, error: "后台账号尚未配置，请先设置 ADMIN_PASSWORD" },
      { status: 503 },
    );
  }

  const key = clientKey(req);
  const retryAfter = await checkLoginRateLimit(key);
  if (retryAfter) {
    return NextResponse.json(
      { ok: false, error: "尝试次数过多，请稍后再试" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "无效的请求体" }, { status: 400 });
  }

  if (
    typeof body.username !== "string"
    || typeof body.password !== "string"
    || !(await adminCredentialsMatch(body.username, body.password))
  ) {
    await recordLoginAttempt(key);
    return NextResponse.json({ ok: false, error: "账号或密码错误" }, { status: 401 });
  }

  await clearLoginAttempts(key);
  const sessionSecret = await effectiveAdminSessionSecret();
  if (!sessionSecret) {
    return NextResponse.json({ ok: false, error: "后台会话配置不完整" }, { status: 503 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, adminSessionCookieValue(sessionSecret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
  return res;
}
