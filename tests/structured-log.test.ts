import { describe, expect, it } from "vitest";
import { createStructuredLogger, formatStructuredLog } from "@/lib/structured-log";

describe("structured logging", () => {
  it("emits one machine-readable record with stable context", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger(
      { service: "worker", workerId: "worker-1" },
      {
        now: () => new Date("2026-07-22T08:00:00.000Z"),
        write: (_level, line) => lines.push(line),
      },
    ).child({ monitorId: "monitor-1", runId: "run-1" });

    logger.info("collection.succeeded", { fetchedCount: 8, durationMs: 1250 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      timestamp: "2026-07-22T08:00:00.000Z",
      level: "info",
      event: "collection.succeeded",
      service: "worker",
      workerId: "worker-1",
      monitorId: "monitor-1",
      runId: "run-1",
      fetchedCount: 8,
      durationMs: 1250,
    });
  });

  it("redacts credential-like fields and serializes errors safely", () => {
    const line = formatStructuredLog("error", "provider.failed", {
      apiKey: "sk-secret",
      nested: { access_token: "secret-token", provider: "example" },
      inputTokens: 1234,
      error: Object.assign(new Error("HTTP 429"), { code: "RATE_LIMITED" }),
    }, undefined, new Date("2026-07-22T08:00:00.000Z"));
    const record = JSON.parse(line);

    expect(record.apiKey).toBe("[REDACTED]");
    expect(record.nested).toEqual({ access_token: "[REDACTED]", provider: "example" });
    expect(record.inputTokens).toBe(1234);
    expect(record.error).toMatchObject({ name: "Error", message: "HTTP 429", code: "RATE_LIMITED" });
  });

  it("does not crash on circular diagnostic objects", () => {
    const diagnostic: Record<string, unknown> = {};
    diagnostic.self = diagnostic;
    expect(() => formatStructuredLog("warn", "diagnostic.circular", { diagnostic })).not.toThrow();
    expect(JSON.parse(formatStructuredLog("warn", "diagnostic.circular", { diagnostic })).diagnostic.self)
      .toBe("[CIRCULAR]");
  });
});
