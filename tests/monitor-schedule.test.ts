import { describe, expect, it } from "vitest";
import {
  initialStaggeredRunAt,
  monitorStaggerKey,
  nextStaggeredRunAt,
  POLL_INTERVAL_GROUPS,
  POLL_INTERVAL_OPTIONS,
} from "@/lib/monitor-schedule";

describe("monitor schedule staggering", () => {
  it("offers continuous practical presets between hourly and low-frequency monitoring", () => {
    expect(POLL_INTERVAL_OPTIONS.map((option) => option.value)).toEqual([
      10, 15, 20, 30, 45,
      60, 90, 120, 180, 240, 300, 360,
      480, 720, 1440,
    ]);
    expect(POLL_INTERVAL_GROUPS.flatMap((group) => [...group.values])).toEqual(
      POLL_INTERVAL_OPTIONS.map((option) => option.value),
    );
  });

  it("spreads newly-created monitors within the initial window", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    const first = initialStaggeredRunAt({
      now,
      intervalMinutes: 30,
      staggerKey: monitorStaggerKey({ platform: "wechat", name: "公众号 A", config: { mpId: "a" } }),
    });
    const second = initialStaggeredRunAt({
      now,
      intervalMinutes: 30,
      staggerKey: monitorStaggerKey({ platform: "wechat", name: "公众号 B", config: { mpId: "b" } }),
    });

    expect(first.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(first.getTime()).toBeLessThan(now.getTime() + 30 * 60_000);
    expect(second.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(second.getTime()).toBeLessThan(now.getTime() + 30 * 60_000);
    expect(first.getTime()).not.toBe(second.getTime());
  });

  it("keeps recurring schedules on the same interval grid", () => {
    const staggerKey = monitorStaggerKey({ id: "monitor-a", platform: "wechat", name: "公众号 A" });
    const first = nextStaggeredRunAt({
      now: new Date("2026-07-15T00:00:00.000Z"),
      intervalMinutes: 30,
      staggerKey,
      minDelaySeconds: 30,
    });
    const second = nextStaggeredRunAt({
      now: new Date(first.getTime() + 1_000),
      intervalMinutes: 30,
      staggerKey,
      minDelaySeconds: 30,
    });

    expect(second.getTime() - first.getTime()).toBe(30 * 60_000);
  });
});
