import { NextResponse } from "next/server";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { loadApiCredentials, saveApiCredentials } from "@/db/queries";
import { sql } from "drizzle-orm";

/**
 * 管理后台鉴权。
 *
 * 人与程序使用不同凭据：
 * - 管理员通过 ADMIN_USERNAME + ADMIN_PASSWORD 登录，浏览器只保存派生后的 httpOnly 会话。
 * - 脚本 / CI 仍可使用 ADMIN_API_TOKEN 作为 Bearer token，不在登录界面暴露。
 * - 登录密码、会话密钥和程序 API token 各司其职，不能相互回退。
 * - 未配置凭据时一律拒绝访问，避免部署配置错误导致后台裸奔。
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

/** 浏览器登录密码。API token 不能兼任网页登录密码。 */
export function getAdminPassword(): string | undefined {
  return configuredValue(process.env.ADMIN_PASSWORD);
}

/** 会话签名密钥。生产环境必须独立配置，不得回退到登录密码。 */
export function getAdminSessionSecret(): string | undefined {
  const configured = configuredValue(process.env.ADMIN_SESSION_SECRET);
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ADMIN_SESSION_SECRET is required in production. " +
      "It must be a random 32+ byte value, different from ADMIN_PASSWORD and ADMIN_API_TOKEN."
    );
  }
  // Development fallback: use admin password for convenience
  return getAdminPassword();
}

export function isAdminAuthConfigured(): boolean {
  return Boolean(getAdminPassword());
}

function secretsEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

const ADMIN_SESSION_VERSION_KEY = "ADMIN_SESSION_VERSION";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Signed session payload: base64url(payload):base64url(signature).
 *  Payload: "username:iat:exp:sid:format:dbVersion". Timestamps are epoch seconds. */
export async function adminSessionCookieValue(secret: string, username = getAdminUsername()): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const version = await adminSessionVersion();
  const payload = [
    username,
    now,
    now + Math.floor(SESSION_TTL_MS / 1000),
    randomBytes(12).toString("base64url"),
    "v4",
    String(version),
  ].join(":");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}:${sig}`;
}

/** Parse and verify a session cookie. Returns the username if valid. */
export async function verifySessionCookie(value: string): Promise<string | null> {
  // Backward-compat: old HMAC-only format
  if (!value.includes(":")) {
    // Legacy cookies accepted until 2026-09-01; after that, require re-login.
    if (Date.now() > Date.UTC(2026, 8, 1)) return null;
    const secret = await effectiveAdminSessionSecret();
    if (!secret) return null;
    const expected = createHmac("sha256", secret)
      .update(`jianwei-admin-session-v2:${getAdminUsername()}`)
      .digest("base64url");
    return secretsEqual(value, expected) ? getAdminUsername() : null;
  }

  const [payloadB64, sigB64] = value.split(":");
  if (!payloadB64 || !sigB64) return null;

  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const parts = payload.split(":");
  // payload: username:iat:exp:sid:format[:dbVersion]
  if (parts.length < 5) return null;
  const [username, iatStr, expStr, , format, dbVersionStr] = parts;

  const now = Math.floor(Date.now() / 1000);
  const iat = Number(iatStr);
  if (Number.isFinite(iat) && iat > now + 300) return null; // clock skew guard
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now) return null;

  // v4+ sessions carry a DB version; reject if the DB has been bumped since.
  if (format === "v4" || format === "v3") {
    const payloadVersion = Number(dbVersionStr);
    const currentVersion = await adminSessionVersion();
    if (Number.isFinite(payloadVersion) && payloadVersion < currentVersion) return null;
  }

  const secret = await effectiveAdminSessionSecret();
  if (!secret) return null;

  const expectedSig = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!secretsEqual(sigB64, expectedSig)) return null;

  return username;
}

export async function adminSessionVersion(): Promise<number> {
  try {
    const rows = await loadApiCredentials();
    const row = rows.find((r) => r.key === ADMIN_SESSION_VERSION_KEY);
    const version = row ? Number(row.value) : 1;
    return Number.isFinite(version) && version > 0 ? version : 1;
  } catch {
    return 1;
  }
}

export async function bumpAdminSessionVersion(): Promise<void> {
  const { db } = await import("@/db");
  await db.execute(sql`
    INSERT INTO api_credentials (key, value, updated_at)
    VALUES ('${ADMIN_SESSION_VERSION_KEY}', '2', now())
    ON CONFLICT (key) DO UPDATE
    SET value = (api_credentials.value::int + 1)::text,
        updated_at = now()
  `);
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
  const value = cookieValue(req);
  if (!value) return false;
  return Boolean(await verifySessionCookie(value));
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
 * 未配置凭据也必须拒绝；本地开发由 start.sh / .env 显式生成凭据。
 */
export async function requireWriteAuth(req: Request): Promise<NextResponse | null> {
  if (hasValidBearer(req)) return null;
  if (await hasValidSession(req)) return null;

  return NextResponse.json(
    { ok: false, error: "unauthorized: 请登录管理后台或提供有效 API 令牌" },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="Jianwei Admin API"' },
    },
  );
}

/** 校验管理页会话；未配置鉴权时拒绝访问。 */
export async function pageCookieOk(session: string | undefined): Promise<boolean> {
  if (!session) return false;
  return Boolean(await verifySessionCookie(session));
}
