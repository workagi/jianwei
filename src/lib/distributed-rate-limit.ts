import { db } from "@/db";
import { sql } from "drizzle-orm";

const localNextAllowedAt = new Map<string, number>();

function shouldUseMemoryBackend(): boolean {
  const configured = process.env.SUMMARY_RATE_LIMIT_BACKEND?.trim().toLowerCase();
  if (configured === "memory") return true;
  if (configured === "database") return false;
  return process.env.NODE_ENV === "test";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveMemorySlot(key: string, intervalMs: number): Promise<number> {
  const now = Date.now();
  const grantedAt = Math.max(now, localNextAllowedAt.get(key) ?? 0);
  localNextAllowedAt.set(key, grantedAt + intervalMs);
  return grantedAt;
}

async function reserveDatabaseSlot(key: string, intervalMs: number): Promise<number> {
  const rows = await db.execute<{ grantedAt: Date | string }>(sql`
    INSERT INTO rate_limit_slots ("key", next_allowed_at, updated_at)
    VALUES (
      ${key},
      now() + (${intervalMs} * interval '1 millisecond'),
      now()
    )
    ON CONFLICT ("key") DO UPDATE SET
      next_allowed_at = greatest(rate_limit_slots.next_allowed_at, now())
        + (${intervalMs} * interval '1 millisecond'),
      updated_at = now()
    RETURNING next_allowed_at - (${intervalMs} * interval '1 millisecond') AS "grantedAt"
  `);
  const value = rows[0]?.grantedAt;
  const grantedAt = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(grantedAt)) throw new Error("SUMMARY_RATE_LIMIT_SLOT_INVALID");
  return grantedAt;
}

/**
 * Atomically reserve one provider request time across every process sharing
 * the database, then wait until that slot. Tests use the deterministic memory
 * backend unless explicitly configured otherwise.
 */
export async function waitForDistributedRateLimit(key: string, intervalMs: number): Promise<void> {
  if (intervalMs <= 0) return;
  const grantedAt = shouldUseMemoryBackend()
    ? await reserveMemorySlot(key, intervalMs)
    : await reserveDatabaseSlot(key, intervalMs);
  const waitMs = grantedAt - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

export function resetDistributedRateLimitForTests(): void {
  localNextAllowedAt.clear();
}
