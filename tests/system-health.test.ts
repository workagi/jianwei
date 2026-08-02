import { describe, expect, it } from "vitest";
import {
  deriveWorkerHealth,
  deriveWorkerHealthSummary,
  deriveWorkerRuntimeStatus,
  selectWorkerHeartbeats,
} from "@/lib/system-health";

describe("deriveWorkerRuntimeStatus", () => {
  it("does not degrade a new worker that has no collection history", () => {
    expect(deriveWorkerRuntimeStatus({
      consecutivePollFailures: 0,
      pollFailureThreshold: 3,
      consecutiveCollectionFailures: 99,
      collectionFailureThreshold: 3,
      lastCollectionFailureAt: null,
    })).toBe("ok");
  });

  it("degrades after repeated collection failures even when polling still works", () => {
    expect(deriveWorkerRuntimeStatus({
      consecutivePollFailures: 0,
      pollFailureThreshold: 3,
      consecutiveCollectionFailures: 3,
      collectionFailureThreshold: 3,
      lastCollectionFailureAt: new Date("2026-07-16T03:59:00.000Z"),
    })).toBe("degraded");
  });
});

describe("deriveWorkerHealth", () => {
  const now = new Date("2026-07-16T04:00:00.000Z");

  it("reports a fresh worker heartbeat as healthy", () => {
    expect(deriveWorkerHealth({
      status: "ok",
      lastHeartbeatAt: new Date(now.getTime() - 30_000),
      now,
      staleAfterSeconds: 300,
    })).toBe("ok");
  });

  it("reports stale or unhealthy heartbeats as delayed", () => {
    expect(deriveWorkerHealth({
      status: "ok",
      lastHeartbeatAt: new Date(now.getTime() - 301_000),
      now,
      staleAfterSeconds: 300,
    })).toBe("delayed");
    expect(deriveWorkerHealth({ status: "failed", lastHeartbeatAt: now, now })).toBe("delayed");
  });

  it("keeps a fresh but repeatedly failing worker visibly degraded", () => {
    expect(deriveWorkerHealth({
      status: "degraded",
      lastHeartbeatAt: new Date(now.getTime() - 30_000),
      now,
      staleAfterSeconds: 300,
    })).toBe("degraded");
  });

  it("reports a missing heartbeat as unknown", () => {
    expect(deriveWorkerHealth({ status: "ok", lastHeartbeatAt: null, now })).toBe("unknown");
  });
});

describe("deriveWorkerHealthSummary", () => {
  const now = new Date("2026-07-16T04:00:00.000Z");

  it("does not let a fresh worker hide a delayed worker", () => {
    const summary = deriveWorkerHealthSummary([
      { status: "ok", lastHeartbeatAt: new Date(now.getTime() - 30_000) },
      { status: "ok", lastHeartbeatAt: new Date(now.getTime() - 301_000) },
    ], { now, staleAfterSeconds: 300 });

    expect(summary.state).toBe("delayed");
    expect(summary.total).toBe(2);
    expect(summary.healthy).toBe(1);
    expect(summary.delayed).toBe(1);
  });

  it("keeps a fresh degraded worker visible without calling it dead", () => {
    const summary = deriveWorkerHealthSummary([
      { status: "ok", lastHeartbeatAt: new Date(now.getTime() - 30_000) },
      { status: "degraded", lastHeartbeatAt: new Date(now.getTime() - 20_000) },
    ], { now, staleAfterSeconds: 300 });

    expect(summary.state).toBe("degraded");
    expect(summary.healthy).toBe(1);
    expect(summary.degraded).toBe(1);
    expect(summary.delayed).toBe(0);
  });

  it("reports an empty worker fleet as unknown", () => {
    expect(deriveWorkerHealthSummary([], { now }).state).toBe("unknown");
  });
});

describe("selectWorkerHeartbeats", () => {
  it("prefers the stable single-worker row over legacy random rows", () => {
    const stable = { service: "worker", status: "ok", lastHeartbeatAt: "2026-07-16T04:00:00.000Z" };
    const legacy = { service: "worker:old-random-id", status: "ok", lastHeartbeatAt: "2026-07-15T04:00:00.000Z" };
    expect(selectWorkerHeartbeats([legacy, stable])).toEqual([stable]);
  });

  it("keeps all explicitly configured worker instances", () => {
    const first = { service: "worker:one", status: "ok", lastHeartbeatAt: "2026-07-16T04:00:00.000Z" };
    const second = { service: "worker:two", status: "ok", lastHeartbeatAt: "2026-07-16T03:59:00.000Z" };
    expect(selectWorkerHeartbeats([first, second])).toEqual([first, second]);
  });
});
