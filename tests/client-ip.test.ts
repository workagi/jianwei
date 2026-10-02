import { describe, expect, it } from "vitest";
import { loginClientKey } from "@/lib/client-ip";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://web:3000/api/auth/login", { headers });
}

describe("login client identity", () => {
  it("uses the dedicated header only when the deployment explicitly trusts it", () => {
    const req = request({
      "x-jianwei-client-ip": "203.0.113.10",
      "x-real-ip": "172.18.0.2",
    });
    expect(loginClientKey(req, { TRUSTED_CLIENT_IP_HEADER: "x-jianwei-client-ip" })).toBe("203.0.113.10");
    expect(loginClientKey(req, {})).toBe("local");
  });

  it("rejects forged or malformed client addresses", () => {
    const req = request({
      "x-jianwei-client-ip": "forged-value",
      "x-forwarded-for": "198.51.100.8",
    });
    expect(loginClientKey(req, { TRUSTED_CLIENT_IP_HEADER: "x-jianwei-client-ip" })).toBe("local");
  });

  it("retains the explicit trusted-proxy compatibility path", () => {
    const req = request({
      "x-real-ip": "172.18.0.2",
      "x-forwarded-for": "198.51.100.8, 172.18.0.2",
    });
    expect(loginClientKey(req, { TRUSTED_PROXY_IP: "172.18.0.2" })).toBe("198.51.100.8");
  });
});
