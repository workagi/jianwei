import { NextResponse } from "next/server";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { loadApiCredentials, saveApiCredentials } from "@/db/queries";

/**
 * 管理后台鉴权。
 *
 * 人与程序使用不同凭据：
 * - 管理员通过 ADMIN_USERNAME + ADMIN_PASSWORD 登录，浏览器只保存派生后的 httpOnly 会话。
 * - 脚本 / CI 仍可使用 ADMIN_API_TOKEN 作为 Bearer token，不在登录界面暴露。
 * - 老部署尚未设置 ADMIN_PASSWORD 时，暂时允许把原 ADMIN_API_TOKEN 当作登录密码，
 *   便于平滑升级；start.sh 会为新部署补齐独立密码。
 */

export const ADMIN_COOKIE = "sd_admin_session";
const ADMIN_PASSWORD_HASH_KEY = "ADMIN_LOGIN_PASSWORD_HASH";
const ADMIN_SESSION_SECRET_KEY = "ADMIN_LOGIN_SESSION_SECRET";

function configuredValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/** 程序调用写接口使用的可选 API 令牌。 */
export function getAdminToken(): string | undefined {
  return configuredValue(process.env.ADMIN_API_TOKEN);
}

/** 单用户后台的登录账号，未显式设置时默认为 admin。 */
export function getAdminUsername(): string {
  return configuredValue(process.env.ADMIN_USERNAME) ?? "admin";
}

/** 浏览器登录密码；兼容旧部署把 API token 临时作为密码。 */
export function getAdminPassword(): string | undefined {
  return configuredValue(process.env.ADMIN_PASSWORD) ?? getAdminToken();
}

/** 会话签名密钥。单独配置后，改登录密码不会强制所有设备退出。 */
export function getAdminSessionSecret(): string | undefined {
  return configuredValue(process.env.ADMIN_SESSION_SECRET) ?? getAdminPassword() ?? getAdminToken();
}

export function isAdminAuthConfigured(): boolean {
  return Boolean(getAdminPassword() || getAdminToken());
}

function secretsEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Cookie 只保存签名后的会话值，不保存账号、密码或 API token。 */
export function adminSessionCookieValue(secret: string, username = getAdminUsername()): string {
  return createHmac("sha256", secret)
    .update(`jianwei-admin-session-v2:${username}`)
    .digest("base64url");
}

export function hashAdminPassword(password: string, salt = randomBytes(16)): string {
  const derived = scryptSync(password, salt, 32);
  return `scrypt:v1:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export function passwordMatchesHash(password: string, storedHash: string): boolean {
  const [algorithm, version, saltText, hashText] = storedHash.split(":");
  if (algorithm !== "scrypt" || version !== "v1" || !saltText || !hashText) return false;
  try {
    const expected = Buffer.from(hashText, "base64url");
    const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function adminAuthOverrides(): Promise<{ passwordHash?: string; sessionSecret?: string }> {
  const rows = await loadApiCredentials();
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    passwordHash: configuredValue(values.get(ADMIN_PASSWORD_HASH_KEY)),
    sessionSecret: configuredValue(values.get(ADMIN_SESSION_SECRET_KEY)),
  };
}

export async function effectiveAdminSessionSecret(): Promise<string | undefined> {
  const overrides = await adminAuthOverrides();
  return overrides.sessionSecret ?? getAdminSessionSecret() ?? overrides.passwordHash;
}

export async function adminCredentialsMatch(username: string, password: string): Promise<boolean> {
  if (!secretsEqual(username.trim(), getAdminUsername())) return false;
  const overrides = await adminAuthOverrides();
  if (overrides.passwordHash) return passwordMatchesHash(password, overrides.passwordHash);
  const expectedPassword = getAdminPassword();
  return Boolean(expectedPassword && secretsEqual(password, expectedPassword));
}

export async function changeAdminPassword(currentPassword: string, newPassword: string): Promise<string | null> {
  if (!(await adminCredentialsMatch(getAdminUsername(), currentPassword))) return null;
  const nextSessionSecret = randomBytes(32).toString("base64url");
  await saveApiCredentials([
    { key: ADMIN_PASSWORD_HASH_KEY, value: hashAdminPassword(newPassword) },
    { key: ADMIN_SESSION_SECRET_KEY, value: nextSessionSecret },
  ]);
  return nextSessionSecret;
}

function cookieValue(req: Request): string | undefined {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`).exec(cookieHeader);
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function hasValidSession(req: Request): Promise<boolean> {
  const sessionSecret = await effectiveAdminSessionSecret();
  const value = cookieValue(req);
  return Boolean(
    sessionSecret
      && value
      && secretsEqual(value, adminSessionCookieValue(sessionSecret)),
  );
}

function hasValidBearer(req: Request): boolean {
  const expected = getAdminToken();
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return Boolean(match && secretsEqual(match[1], expected));
}

/**
 * 保护写操作。后台页面使用同源 httpOnly 会话；自动化脚本使用 Bearer token。
 * 完全未配置密码和 token 时维持本机开发的放行模式。
 */
export async function requireWriteAuth(req: Request): Promise<NextResponse | null> {
  if (hasValidBearer(req)) return null;
  const overrides = await adminAuthOverrides();
  if (!overrides.passwordHash && !isAdminAuthConfigured()) return null;
  if (await hasValidSession(req)) return null;

  return NextResponse.json(
    { ok: false, error: "unauthorized: 请登录管理后台或提供有效 API 令牌" },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="Jianwei Admin API"' },
    },
  );
}

/** 校验管理页会话；完全未配置鉴权时仅用于本机开发并直接放行。 */
export async function pageCookieOk(session: string | undefined): Promise<boolean> {
  const overrides = await adminAuthOverrides();
  if (!overrides.passwordHash && !isAdminAuthConfigured()) return true;
  const sessionSecret = overrides.sessionSecret ?? getAdminSessionSecret() ?? overrides.passwordHash;
  if (!sessionSecret || !session) return false;
  return secretsEqual(session, adminSessionCookieValue(sessionSecret));
}
