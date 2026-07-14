import { NextResponse } from "next/server";

/**
 * 管理员访问令牌相关的鉴权辅助。
 *
 * 设计要点：
 * - 鉴权逻辑放在 Route Handler（Node runtime）与服务端组件里，而非 Next
 *   middleware。因为 middleware 运行在 edge runtime，读不到容器注入的运行时
 *   环境变量（会被构建期静态替换为 undefined）。
 * - 未配置 ADMIN_API_TOKEN 时，所有写操作与管理页放行，兼容本机 / 内网自托管。
 * - 配置后：写操作（POST/PATCH/DELETE/PUT）必须携带 `Authorization: Bearer`；
 *   /admin 页面通过 httpOnly cookie 校验，未登录显示令牌输入页。
 */

export const ADMIN_COOKIE = "sd_token";

/** 返回已配置的管理员令牌；未配置或为空时返回 undefined（放行模式）。 */
export function getAdminToken(): string | undefined {
  const t = process.env.ADMIN_API_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

/** 请求是否携带了有效的管理员令牌（两种等价来源）。 */
function hasValidToken(req: Request, expected: string): boolean {
  // 1) Authorization: Bearer <token>（写操作 API 的标准用法，也便于脚本/CI 调用）
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m && m[1] === expected) return true;

  // 2) /api/auth/login 写入的 httpOnly cookie（值即令牌本身）。
  //    管理后台的 fetch 同源会自动带上该 cookie，但 JS 读不到它，
  //    因此这里直接以 cookie 作为 Bearer 的等价凭据，让后台 UI 的保存/删除/验证可用。
  //    因 cookie 为 sameSite=lax，跨站请求不会携带，故接受 cookie 不会引入 CSRF。
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cm = new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`).exec(cookieHeader);
  if (cm && decodeURIComponent(cm[1]) === expected) return true;

  return false;
}

/**
 * 保护写操作。返回 null 表示校验通过；返回 NextResponse 表示应直接拒绝。
 * 接受 `Authorization: Bearer` 或登录后的 `sd_token` cookie 两种凭据。
 */
export function requireWriteAuth(req: Request): NextResponse | null {
  const expected = getAdminToken();
  if (!expected) return null;

  if (hasValidToken(req, expected)) return null;

  return NextResponse.json(
    { ok: false, error: "unauthorized: 缺少或错误的管理员令牌" },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="SignalDeck Admin"' },
    },
  );
}

/** 校验管理页 cookie 令牌；未配置令牌时始终放行。 */
export function pageCookieOk(token: string | undefined): boolean {
  const expected = getAdminToken();
  if (!expected) return true;
  return token === expected;
}
