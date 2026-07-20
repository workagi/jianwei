import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  loadApiCredentials: vi.fn(),
  saveApiCredentials: vi.fn(),
}));

vi.mock("@/db/queries", () => dbMocks);

import {
  ADMIN_COOKIE,
  adminCredentialsMatch,
  adminSessionCookieValue,
  changeAdminPassword,
  getAdminSessionSecret,
  getAdminToken,
  getAdminUsername,
  hashAdminPassword,
  pageCookieOk,
  passwordMatchesHash,
  requireWriteAuth,
} from "@/lib/auth";

const TOKEN = "unit-test-api-token-123";
const PASSWORD = "unit-test-admin-password";

beforeEach(() => {
  dbMocks.loadApiCredentials.mockResolvedValue([]);
  dbMocks.saveApiCredentials.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.ADMIN_API_TOKEN;
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_SESSION_SECRET;
  vi.clearAllMocks();
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/monitors", { headers });
}

describe("管理员账号登录", () => {
  it("默认账号为 admin，并校验独立密码", async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    expect(getAdminUsername()).toBe("admin");
    await expect(adminCredentialsMatch("admin", PASSWORD)).resolves.toBe(true);
    await expect(adminCredentialsMatch("root", PASSWORD)).resolves.toBe(false);
    await expect(adminCredentialsMatch("admin", `${PASSWORD}-wrong`)).resolves.toBe(false);
  });

  it("支持自定义管理员账号", async () => {
    process.env.ADMIN_USERNAME = "jianwei";
    process.env.ADMIN_PASSWORD = PASSWORD;
    await expect(adminCredentialsMatch("jianwei", PASSWORD)).resolves.toBe(true);
  });

  it("未设置独立密码的旧部署可临时使用 API token 登录", async () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    await expect(adminCredentialsMatch("admin", TOKEN)).resolves.toBe(true);
  });

  it("数据库密码哈希优先于环境变量密码", async () => {
    const storedHash = hashAdminPassword("changed-password");
    dbMocks.loadApiCredentials.mockResolvedValue([
      { key: "ADMIN_LOGIN_PASSWORD_HASH", value: storedHash },
      { key: "ADMIN_LOGIN_SESSION_SECRET", value: "rotated-secret" },
    ]);
    process.env.ADMIN_PASSWORD = PASSWORD;
    await expect(adminCredentialsMatch("admin", "changed-password")).resolves.toBe(true);
    await expect(adminCredentialsMatch("admin", PASSWORD)).resolves.toBe(false);
  });

  it("scrypt 密码哈希可校验且不包含明文", () => {
    const storedHash = hashAdminPassword(PASSWORD);
    expect(storedHash).not.toContain(PASSWORD);
    expect(passwordMatchesHash(PASSWORD, storedHash)).toBe(true);
    expect(passwordMatchesHash("wrong-password", storedHash)).toBe(false);
  });

  it("修改密码时保存哈希并轮换会话密钥", async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    const nextSecret = await changeAdminPassword(PASSWORD, "shorter-password");
    expect(nextSecret).toBeTruthy();
    expect(dbMocks.saveApiCredentials).toHaveBeenCalledOnce();
    const saved = dbMocks.saveApiCredentials.mock.calls[0][0] as { key: string; value: string }[];
    const passwordRow = saved.find((row) => row.key === "ADMIN_LOGIN_PASSWORD_HASH");
    expect(passwordRow).toBeTruthy();
    expect(passwordMatchesHash("shorter-password", passwordRow!.value)).toBe(true);
  });

  it("派生会话可访问页面且不会保存原密码", async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    const secret = getAdminSessionSecret();
    expect(secret).toBe(PASSWORD);
    const session = adminSessionCookieValue(secret!);
    expect(session).not.toContain(PASSWORD);
    await expect(pageCookieOk(session)).resolves.toBe(true);
    await expect(pageCookieOk(PASSWORD)).resolves.toBe(false);
  });
});

describe("requireWriteAuth", () => {
  it("完全未配置鉴权时放行本机开发", async () => {
    expect(getAdminToken()).toBeUndefined();
    await expect(requireWriteAuth(req())).resolves.toBeNull();
  });

  it("配置密码后拒绝未登录的写操作", async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    expect((await requireWriteAuth(req()))?.status).toBe(401);
  });

  it("登录会话可执行后台同源写操作", async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    const session = adminSessionCookieValue(getAdminSessionSecret()!);
    await expect(requireWriteAuth(req({ cookie: `${ADMIN_COOKIE}=${session}` }))).resolves.toBeNull();
  });

  it("拒绝伪造的会话 cookie", async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    expect((await requireWriteAuth(req({ cookie: `${ADMIN_COOKIE}=nope` })))?.status).toBe(401);
  });

  it("保留正确的 Bearer API token 供脚本调用", async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    process.env.ADMIN_API_TOKEN = TOKEN;
    await expect(requireWriteAuth(req({ authorization: `Bearer ${TOKEN}` }))).resolves.toBeNull();
  });

  it("拒绝错误的 Bearer API token", async () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    expect((await requireWriteAuth(req({ authorization: `Bearer wrong-${TOKEN}` })))?.status).toBe(401);
  });

  it("Bearer 前缀大小写不敏感", async () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    await expect(requireWriteAuth(req({ authorization: `bEaReR ${TOKEN}` }))).resolves.toBeNull();
  });
});
