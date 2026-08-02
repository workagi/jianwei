export type WorkerHealthState = "ok" | "degraded" | "delayed" | "unknown";

export type WorkerHeartbeat = {
  status?: string | null;
  lastHeartbeatAt?: Date | string | null;
};

export type WorkerHeartbeatRecord = WorkerHeartbeat & {
  service: string;
};

export type WorkerHealthSummary = {
  state: WorkerHealthState;
  total: number;
  healthy: number;
  degraded: number;
  delayed: number;
  unknown: number;
  freshestHeartbeatAt: Date | null;
  oldestHeartbeatAt: Date | null;
};

/**
 * The default single-worker service key is stable across restarts. If it is
 * present, ignore legacy random `worker:<id>` rows from older deployments;
 * otherwise retain every explicitly configured replica for aggregation.
 */
export function selectWorkerHeartbeats(
  records: WorkerHeartbeatRecord[],
): WorkerHeartbeat[] {
  const defaultHeartbeat = records.find((record) => record.service === "worker");
  return defaultHeartbeat ? [defaultHeartbeat] : records;
}

export function deriveWorkerRuntimeStatus(input: {
  consecutivePollFailures: number;
  pollFailureThreshold: number;
  consecutiveCollectionFailures: number;
  collectionFailureThreshold: number;
  lastCollectionFailureAt?: Date | string | null;
}): "ok" | "degraded" {
  const pollDegraded = input.consecutivePollFailures >= Math.max(1, input.pollFailureThreshold);
  // A worker that has never attempted a collection must remain healthy. This
  // prevents a fresh installation with no due monitors from being reported as
  // degraded merely because the collection threshold is configured badly.
  const collectionDegraded = Boolean(input.lastCollectionFailureAt)
    && input.consecutiveCollectionFailures >= Math.max(1, input.collectionFailureThreshold);
  return pollDegraded || collectionDegraded ? "degraded" : "ok";
}

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
  if (ageMs > staleAfterMs) return "delayed";
  if (input.status === "degraded") return "degraded";
  return input.status === "ok" ? "ok" : "delayed";
}

/**
 * Aggregate every worker heartbeat instead of treating the newest row as the
 * health of the whole worker fleet. A fresh instance must not hide another
 * instance that has stopped reporting.
 */
export function deriveWorkerHealthSummary(
  heartbeats: WorkerHeartbeat[],
  options: {
    now?: Date;
    staleAfterSeconds?: number;
  } = {},
): WorkerHealthSummary {
  const now = options.now ?? new Date();
  const counts = {
    ok: 0,
    degraded: 0,
    delayed: 0,
    unknown: 0,
  } satisfies Record<WorkerHealthState, number>;
  const heartbeatDates: Date[] = [];

  for (const heartbeat of heartbeats) {
    const state = deriveWorkerHealth({
      ...heartbeat,
      now,
      staleAfterSeconds: options.staleAfterSeconds,
    });
    counts[state] += 1;
    if (heartbeat.lastHeartbeatAt) {
      const date = heartbeat.lastHeartbeatAt instanceof Date
        ? heartbeat.lastHeartbeatAt
        : new Date(heartbeat.lastHeartbeatAt);
      if (!Number.isNaN(date.getTime())) heartbeatDates.push(date);
    }
  }

  let state: WorkerHealthState;
  if (heartbeats.length === 0) {
    state = "unknown";
  } else if (counts.delayed > 0) {
    state = "delayed";
  } else if (counts.unknown > 0) {
    state = "unknown";
  } else if (counts.degraded > 0) {
    state = "degraded";
  } else {
    state = "ok";
  }

  return {
    state,
    total: heartbeats.length,
    healthy: counts.ok,
    degraded: counts.degraded,
    delayed: counts.delayed,
    unknown: counts.unknown,
    freshestHeartbeatAt: heartbeatDates.length > 0
      ? new Date(Math.max(...heartbeatDates.map((date) => date.getTime())))
      : null,
    oldestHeartbeatAt: heartbeatDates.length > 0
      ? new Date(Math.min(...heartbeatDates.map((date) => date.getTime())))
      : null,
  };
}
