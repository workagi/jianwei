import { afterEach, describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential, isEncryptedCredential } from "@/lib/credential-crypto";

const original = {
  key: process.env.APP_ENCRYPTION_KEY,
  activeKeyId: process.env.APP_ENCRYPTION_ACTIVE_KEY_ID,
  keyMap: process.env.APP_ENCRYPTION_KEYS_JSON,
};

afterEach(() => {
  if (original.key === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = original.key;
  if (original.activeKeyId === undefined) delete process.env.APP_ENCRYPTION_ACTIVE_KEY_ID;
  else process.env.APP_ENCRYPTION_ACTIVE_KEY_ID = original.activeKeyId;
  if (original.keyMap === undefined) delete process.env.APP_ENCRYPTION_KEYS_JSON;
  else process.env.APP_ENCRYPTION_KEYS_JSON = original.keyMap;
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

  it("uses the selected versioned key and keeps old ciphertext readable after rotation", () => {
    const keyA = Buffer.alloc(32, 11).toString("base64");
    const keyB = Buffer.alloc(32, 12).toString("base64");
    process.env.APP_ENCRYPTION_KEYS_JSON = JSON.stringify({ a: keyA, b: keyB });
    process.env.APP_ENCRYPTION_ACTIVE_KEY_ID = "a";
    const encryptedA = encryptCredential("secret-a");
    expect(encryptedA).toMatch(/^enc:v2:a:/);

    process.env.APP_ENCRYPTION_ACTIVE_KEY_ID = "b";
    const encryptedB = encryptCredential("secret-b");
    expect(encryptedB).toMatch(/^enc:v2:b:/);
    expect(decryptCredential(encryptedA)).toBe("secret-a");
    expect(decryptCredential(encryptedB)).toBe("secret-b");
  });

  it("never falls back to the legacy key for an unknown v2 key id", () => {
    const keyA = Buffer.alloc(32, 13).toString("base64");
    process.env.APP_ENCRYPTION_KEYS_JSON = JSON.stringify({ a: keyA });
    process.env.APP_ENCRYPTION_ACTIVE_KEY_ID = "a";
    const encrypted = encryptCredential("secret-a");

    process.env.APP_ENCRYPTION_KEYS_JSON = JSON.stringify({ b: Buffer.alloc(32, 14).toString("base64") });
    process.env.APP_ENCRYPTION_KEY = keyA;
    expect(() => decryptCredential(encrypted)).toThrow(/unknown encryption key "a"/);
  });

  it("encrypts plaintext that merely starts with an envelope prefix", () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 15).toString("base64");
    const plaintext = "enc:v2:this-is-plain-text";
    const encrypted = encryptCredential(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(isEncryptedCredential(plaintext)).toBe(false);
    expect(decryptCredential(encrypted)).toBe(plaintext);
  });

  it("rejects malformed key maps and missing active key ids instead of silently falling back", () => {
    process.env.APP_ENCRYPTION_KEYS_JSON = "not-json";
    expect(() => encryptCredential("secret")).toThrow(/APP_ENCRYPTION_KEYS_JSON is invalid/);

    process.env.APP_ENCRYPTION_KEYS_JSON = JSON.stringify({ a: Buffer.alloc(32, 16).toString("base64") });
    process.env.APP_ENCRYPTION_ACTIVE_KEY_ID = "missing";
    expect(() => encryptCredential("secret")).toThrow(/not found/);
  });
});
