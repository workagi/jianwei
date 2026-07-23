import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Legacy prefix for credentials encrypted without key versioning. */
const LEGACY_PREFIX = "enc:v1:";
const PREFIX_TEMPLATE = "enc:v2:";

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

function currentPrefix(): string {
  return `${PREFIX_TEMPLATE}${activeKeyId()}:`;
}

type KeyMap = Map<string, Buffer>;
let _keyMap: KeyMap | undefined;

function loadKeyMap(): KeyMap {
  if (_keyMap) return _keyMap;
  const map = new Map<string, Buffer>();
  const json = process.env.APP_ENCRYPTION_KEYS_JSON?.trim();
  if (json) {
    try {
      const entries = JSON.parse(json);
      for (const [keyId, keyB64] of Object.entries(entries)) {
        if (typeof keyB64 !== "string") continue;
        const buf = Buffer.from(keyB64, "base64");
        if (buf.length === 32) map.set(keyId, buf);
      }
    } catch { /* ignore malformed JSON */ }
  }
  _keyMap = map;
  return map;
}

export function isEncryptedCredential(value: string): boolean {
  return value.startsWith(LEGACY_PREFIX) || value.startsWith(PREFIX_TEMPLATE);
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
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          `APP_ENCRYPTION_ACTIVE_KEY_ID "${keyId}" not found in APP_ENCRYPTION_KEYS_JSON. ` +
          "Refusing to encrypt with an unknown key ID.",
        );
      }
      // Dev fallback: use the legacy key
      return { id: keyId, key: encryptionKey() };
    }
    return { id: keyId, key };
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
  const isLegacy = value.startsWith(LEGACY_PREFIX);
  if (!isLegacy && !value.startsWith(PREFIX_TEMPLATE)) return value;

  let key: Buffer;
  let parts: string[];

  if (isLegacy) {
    key = encryptionKey();
    parts = value.slice(LEGACY_PREFIX.length).split(":");
  } else {
    // Format: enc:v2:<keyId>:<iv>:<tag>:<ciphertext>
    const afterPrefix = value.slice(PREFIX_TEMPLATE.length);
    const colonIdx = afterPrefix.indexOf(":");
    if (colonIdx === -1) throw new Error("Stored API credential has an invalid encrypted format");
    const keyId = afterPrefix.slice(0, colonIdx);
    const keyMap = loadKeyMap();
    key = keyMap.get(keyId) ?? encryptionKey();
    parts = afterPrefix.slice(colonIdx + 1).split(":");
  }

  if (parts.length !== 3) throw new Error("Stored API credential has an invalid encrypted format");
  const [ivText, tagText, encryptedText] = parts;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Stored API credential cannot be decrypted; check APP_ENCRYPTION_KEY");
  }
}
