import { writeFile } from "node:fs/promises";
import { db } from "@/db";
import { runtimeHealth } from "@/db/schema";

const WORKER_HEARTBEAT_FILE = "/tmp/jianwei-worker-heartbeat";

/**
 * Write a heartbeat to both the filesystem (for Docker health checks) and the
 * database (for the web dashboard). Returns the database record so callers
 * can chain further checks.
 */
export async function writeHeartbeat(
  workerId: string,
  now = new Date(),
): Promise<void> {
  await Promise.all([
    writeFile(WORKER_HEARTBEAT_FILE, now.toISOString(), "utf8"),
    db
      .insert(runtimeHealth)
      .values({
        service: `worker:${workerId}`,
        status: "ok",
        lastHeartbeatAt: now,
        detail: { pid: process.pid, workerId },
      })
      .onConflictDoUpdate({
        target: runtimeHealth.service,
        set: {
          status: "ok",
          lastHeartbeatAt: now,
          detail: { pid: process.pid, workerId },
        },
      }),
  ]);
}

/**
 * Start a periodic heartbeat timer. Returns a handle so the caller can
 * stop it during graceful shutdown. Heartbeat failures are logged but never
 * crash the worker — the fencing token in the lease is the real safety net.
 */
export function startHeartbeatTimer(
  workerId: string,
  intervalMs: number,
  onError: (error: unknown) => void,
): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    writeHeartbeat(workerId)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return timer;
}
