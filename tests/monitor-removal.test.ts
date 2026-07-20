import { describe, expect, it } from "vitest";
import { archiveMonitorConfig, parseMonitorRemovalOptions } from "@/lib/monitor-removal";

describe("monitor removal options", () => {
  it("keeps history by default", () => {
    expect(parseMonitorRemovalOptions("http://localhost/api/monitors/1")).toEqual({
      cancelWerss: false,
      deleteItems: false,
    });
  });

  it("requires explicit flags for destructive cleanup and WeRSS unsubscribe", () => {
    expect(parseMonitorRemovalOptions("http://localhost/api/monitors/1?deleteItems=1&cancelWerss=1")).toEqual({
      cancelWerss: true,
      deleteItems: true,
    });
  });

  it("preserves monitor configuration when archiving", () => {
    const archivedAt = new Date("2026-07-16T04:00:00.000Z");
    expect(archiveMonitorConfig({ query: "Momenta" }, archivedAt)).toEqual({
      query: "Momenta",
      _archivedAt: archivedAt.toISOString(),
    });
  });
});
