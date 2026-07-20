import { describe, expect, it } from "vitest";
import { deriveWorkerHealth } from "@/lib/system-health";

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

  it("reports a missing heartbeat as unknown", () => {
    expect(deriveWorkerHealth({ status: "ok", lastHeartbeatAt: null, now })).toBe("unknown");
  });
});
