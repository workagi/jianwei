import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

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

export function isEncryptedCredential(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptCredential(value: string): string {
  if (isEncryptedCredential(value)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptCredential(value: string): string {
  if (!isEncryptedCredential(value)) return value;
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Stored API credential has an invalid encrypted format");
  const [ivText, tagText, encryptedText] = parts;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Stored API credential cannot be decrypted; check APP_ENCRYPTION_KEY");
  }
}
