import { describe, expect, it, vi } from "vitest";
import { assertSafeZlzChatEndpoint, normalizeZlzChatBaseUrl } from "@/lib/zlzchat-endpoint";

describe("ZLZChat endpoint policy", () => {
  it("normalizes safe URLs and rejects embedded credentials and the public demo", () => {
    expect(normalizeZlzChatBaseUrl("https://zlz.example/api/?old=1#x")).toBe("https://zlz.example/api");
    expect(() => normalizeZlzChatBaseUrl("http://user:pass@zlz.example")).toThrow("ZLZCHAT_BASE_URL_INVALID");
    expect(() => normalizeZlzChatBaseUrl("http://111.229.83.152:805")).toThrow("ZLZCHAT_PUBLIC_DEMO_FORBIDDEN");
  });

  it("allows public DNS addresses but rejects private DNS results by default", async () => {
    const publicLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    await expect(assertSafeZlzChatEndpoint("https://zlz.example", { lookup: publicLookup })).resolves.toBe("https://zlz.example");

    const privateLookup = vi.fn(async () => [{ address: "10.8.0.5", family: 4 }]);
    await expect(assertSafeZlzChatEndpoint("http://zlz.internal:805", { lookup: privateLookup, allowedOrigins: "" }))
      .rejects.toThrow("ZLZCHAT_PRIVATE_ORIGIN_NOT_ALLOWED");
  });

  it("allows a private address only through an exact deployment origin allowlist", async () => {
    const lookup = vi.fn(async () => [{ address: "172.20.0.8", family: 4 }]);
    await expect(assertSafeZlzChatEndpoint("http://zlzchat:805/api", {
      lookup,
      allowedOrigins: "http://zlzchat:805",
    })).resolves.toBe("http://zlzchat:805/api");

    await expect(assertSafeZlzChatEndpoint("http://zlzchat:806/api", {
      lookup,
      allowedOrigins: "http://zlzchat:805",
    })).rejects.toThrow("ZLZCHAT_PRIVATE_ORIGIN_NOT_ALLOWED");
  });

  it("never allows loopback or link-local metadata addresses", async () => {
    await expect(assertSafeZlzChatEndpoint("http://127.0.0.1:805", {
      allowedOrigins: "http://127.0.0.1:805",
    })).rejects.toThrow("ZLZCHAT_BASE_URL_UNSAFE");
    await expect(assertSafeZlzChatEndpoint("http://[::1]:805", {
      allowedOrigins: "http://[::1]:805",
    })).rejects.toThrow("ZLZCHAT_BASE_URL_UNSAFE");

    const metadataLookup = vi.fn(async () => [{ address: "169.254.169.254", family: 4 }]);
    await expect(assertSafeZlzChatEndpoint("https://metadata.example", {
      lookup: metadataLookup,
      allowedOrigins: "https://metadata.example",
    })).rejects.toThrow("ZLZCHAT_BASE_URL_UNSAFE");
  });

  it("blocks a DNS alias that resolves to the known public demo", async () => {
    const lookup = vi.fn(async () => [{ address: "111.229.83.152", family: 4 }]);
    await expect(assertSafeZlzChatEndpoint("https://demo-alias.example", { lookup, allowedOrigins: "" }))
      .rejects.toThrow("ZLZCHAT_BASE_URL_UNSAFE");
  });
});
