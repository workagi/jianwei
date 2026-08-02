import { describe, expect, it } from "vitest";
import { staleRunReaperIntervalMs } from "@/worker/stale-run-reaper";

describe("staleRunReaperIntervalMs", () => {
  it("defaults to a three-minute runtime cleanup cadence", () => {
    expect(staleRunReaperIntervalMs(undefined)).toBe(180_000);
  });

  it("clamps cleanup cadence between one and five minutes", () => {
    expect(staleRunReaperIntervalMs("1")).toBe(60_000);
    expect(staleRunReaperIntervalMs("120")).toBe(120_000);
    expect(staleRunReaperIntervalMs("9999")).toBe(300_000);
  });
});
