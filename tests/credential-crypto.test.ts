import { afterEach, describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential, isEncryptedCredential } from "@/lib/credential-crypto";

const originalKey = process.env.APP_ENCRYPTION_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = originalKey;
});

describe("API credential encryption", () => {
  it("round-trips values using authenticated encryption", () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptCredential("secret-api-key");

    expect(isEncryptedCredential(encrypted)).toBe(true);
    expect(encrypted).not.toContain("secret-api-key");
    expect(decryptCredential(encrypted)).toBe("secret-api-key");
  });

  it("keeps legacy plaintext readable for automatic migration", () => {
    expect(decryptCredential("legacy-secret")).toBe("legacy-secret");
  });

  it("rejects ciphertext when the configured key changes", () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
    const encrypted = encryptCredential("secret-api-key");
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
    expect(() => decryptCredential(encrypted)).toThrow(/APP_ENCRYPTION_KEY/);
  });
});
