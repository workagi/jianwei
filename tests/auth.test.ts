import { describe, it, expect, afterEach } from "vitest";
import { requireWriteAuth, getAdminToken, ADMIN_COOKIE } from "@/lib/auth";

const TOKEN = "unit-test-token-123";

afterEach(() => {
  delete process.env.ADMIN_API_TOKEN;
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/monitors", { headers });
}

describe("requireWriteAuth", () => {
  it("放行当未配置 ADMIN_API_TOKEN（内网/本机模式）", () => {
    delete process.env.ADMIN_API_TOKEN;
    expect(getAdminToken()).toBeUndefined();
    expect(requireWriteAuth(req())).toBeNull();
  });

  it("拒绝当缺少 Authorization 头", () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    const res = requireWriteAuth(req());
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it("拒绝当 Bearer 令牌错误", () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    const res = requireWriteAuth(req({ authorization: `Bearer wrong-${TOKEN}` }));
    expect(res?.status).toBe(401);
  });

  it("放行当 Bearer 令牌正确", () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    expect(requireWriteAuth(req({ authorization: `Bearer ${TOKEN}` }))).toBeNull();
  });

  it("放行当 sd_token cookie 与令牌一致（后台 UI 同源请求）", () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    const res = requireWriteAuth(req({ cookie: `${ADMIN_COOKIE}=${TOKEN}` }));
    expect(res).toBeNull();
  });

  it("拒绝当 cookie 令牌错误", () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    const res = requireWriteAuth(req({ cookie: `${ADMIN_COOKIE}=nope` }));
    expect(res?.status).toBe(401);
  });

  it("大小写不敏感匹配 Bearer 前缀", () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    expect(requireWriteAuth(req({ authorization: `bEaReR ${TOKEN}` }))).toBeNull();
  });
});
