import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Legacy prefix for credentials encrypted without key versioning. */
const LEGACY_PREFIX = "enc:v1:";
const PREFIX_TEMPLATE = "enc:v2:";
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

interface ParsedEncryptedCredential {
  version: "v1" | "v2";
  keyId?: string;
  ivText: string;
  tagText: string;
  encryptedText: string;
}

function encryptionKey(): Buffer {
  const configured = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_ENCRYPTION_KEY is required in production");
    }
    return createHash("sha256").update("signaldeck-local-development-key").digest();
  }

  const decoded = Buffer.from(configured, "base64");
  if (decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === configured.replace(/=+$/, "")) {
    return decoded;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_ENCRYPTION_KEY must be a 32-byte Base64 value");
  }
  return createHash("sha256").update(configured).digest();
}

/** Active key ID from APP_ENCRYPTION_ACTIVE_KEY_ID, or "v1" for legacy. */
function activeKeyId(): string {
  return process.env.APP_ENCRYPTION_ACTIVE_KEY_ID?.trim() || "v1";
}

type KeyMap = Map<string, Buffer>;

function loadKeyMap(): KeyMap {
  const map = new Map<string, Buffer>();
  const json = process.env.APP_ENCRYPTION_KEYS_JSON?.trim();
  if (json) {
    try {
      const entries = JSON.parse(json) as unknown;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        throw new Error("key map must be an object");
      }
      for (const [keyId, keyB64] of Object.entries(entries)) {
        if (!KEY_ID_PATTERN.test(keyId) || typeof keyB64 !== "string") {
          throw new Error(`invalid encryption key entry: ${keyId}`);
        }
        const buf = Buffer.from(keyB64, "base64");
        const canonical = buf.toString("base64").replace(/=+$/, "");
        if (buf.length !== 32 || canonical !== keyB64.replace(/=+$/, "")) {
          throw new Error(`encryption key ${keyId} must be a 32-byte Base64 value`);
        }
        map.set(keyId, buf);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`APP_ENCRYPTION_KEYS_JSON is invalid: ${detail}`);
    }
  }
  return map;
}

function validBase64Url(value: string, expectedBytes?: number): boolean {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return expectedBytes === undefined || decoded.length === expectedBytes;
  } catch {
    return false;
  }
}

function parseEncryptedCredential(value: string): ParsedEncryptedCredential | null {
  let version: ParsedEncryptedCredential["version"];
  let keyId: string | undefined;
  let body: string;
  if (value.startsWith(LEGACY_PREFIX)) {
    version = "v1";
    body = value.slice(LEGACY_PREFIX.length);
  } else if (value.startsWith(PREFIX_TEMPLATE)) {
    version = "v2";
    const afterPrefix = value.slice(PREFIX_TEMPLATE.length);
    const colonIndex = afterPrefix.indexOf(":");
    if (colonIndex <= 0) return null;
    keyId = afterPrefix.slice(0, colonIndex);
    if (!KEY_ID_PATTERN.test(keyId)) return null;
    body = afterPrefix.slice(colonIndex + 1);
  } else {
    return null;
  }

  const parts = body.split(":");
  if (parts.length !== 3) return null;
  const [ivText, tagText, encryptedText] = parts;
  if (!validBase64Url(ivText, 12) || !validBase64Url(tagText, 16) || !validBase64Url(encryptedText)) {
    return null;
  }
  return { version, keyId, ivText, tagText, encryptedText };
}

export function isEncryptedCredential(value: string): boolean {
  return parseEncryptedCredential(value) !== null;
}

/**
 * Return the key that should be used for NEW encryptions. When a key map is
 * configured (APP_ENCRYPTION_KEYS_JSON), the active key ID selects which key
 * to use. Falls back to APP_ENCRYPTION_KEY only in single-key mode.
 * On startup failure (active ID missing from map), throws immediately in
 * production — writing a key-tagged ciphertext with the wrong key is
 * irreversible data loss.
 */
function activeEncryptionKey(): { id: string; key: Buffer } {
  const keyId = activeKeyId();
  const keyMap = loadKeyMap();
  if (keyMap.size > 0) {
    const key = keyMap.get(keyId);
    if (!key) {
      throw new Error(
        `APP_ENCRYPTION_ACTIVE_KEY_ID "${keyId}" not found in APP_ENCRYPTION_KEYS_JSON. ` +
        "Refusing to encrypt with an unknown key ID.",
      );
    }
    return { id: keyId, key };
  }
  if (keyId !== "v1") {
    throw new Error(
      `APP_ENCRYPTION_ACTIVE_KEY_ID "${keyId}" requires APP_ENCRYPTION_KEYS_JSON`,
    );
  }
  return { id: "v1", key: encryptionKey() };
}

export function encryptCredential(value: string): string {
  if (isEncryptedCredential(value)) return value;
  const iv = randomBytes(12);
  const { id: keyId, key } = activeEncryptionKey();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const prefix = keyId === "v1" ? LEGACY_PREFIX : `${PREFIX_TEMPLATE}${keyId}:`;
  return `${prefix}${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptCredential(value: string): string {
  const parsed = parseEncryptedCredential(value);
  if (!parsed) return value;

  let key: Buffer;
  if (parsed.version === "v1") {
    key = encryptionKey();
  } else {
    const keyMap = loadKeyMap();
    const versionedKey = keyMap.get(parsed.keyId!);
    if (!versionedKey) {
      throw new Error(`Stored API credential references unknown encryption key "${parsed.keyId}"`);
    }
    key = versionedKey;
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(parsed.tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.encryptedText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Stored API credential cannot be decrypted; check APP_ENCRYPTION_KEY");
  }
}
