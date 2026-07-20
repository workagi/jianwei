import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  adminCredentialsMatch,
  adminSessionCookieValue,
  effectiveAdminSessionSecret,
  isAdminAuthConfigured,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "local";
}

function failedTooOften(key: string): number | null {
  const now = Date.now();
  const state = attempts.get(key);
  if (!state || state.resetAt <= now) {
    attempts.delete(key);
    return null;
  }
  return state.count >= MAX_ATTEMPTS ? Math.ceil((state.resetAt - now) / 1000) : null;
}

function recordFailure(key: string) {
  const now = Date.now();
  const state = attempts.get(key);
  if (!state || state.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  state.count += 1;
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
  const retryAfter = failedTooOften(key);
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
    recordFailure(key);
    return NextResponse.json({ ok: false, error: "账号或密码错误" }, { status: 401 });
  }

  attempts.delete(key);
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
