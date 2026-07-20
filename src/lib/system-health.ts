export type WorkerHealthState = "ok" | "delayed" | "unknown";

export function deriveWorkerHealth(input: {
  status?: string | null;
  lastHeartbeatAt?: Date | string | null;
  now?: Date;
  staleAfterSeconds?: number;
}): WorkerHealthState {
  if (!input.lastHeartbeatAt) return "unknown";
  const heartbeat = input.lastHeartbeatAt instanceof Date
    ? input.lastHeartbeatAt
    : new Date(input.lastHeartbeatAt);
  if (Number.isNaN(heartbeat.getTime())) return "unknown";
  const now = input.now ?? new Date();
  const staleAfterMs = Math.max(60, input.staleAfterSeconds ?? 300) * 1000;
  const ageMs = Math.max(0, now.getTime() - heartbeat.getTime());
  return input.status === "ok" && ageMs <= staleAfterMs ? "ok" : "delayed";
}
