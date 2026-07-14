import { describe, it, expect } from "vitest";
import { CONNECTOR_SEED, connectorIdForPlatform } from "@/db/connector-seed";

describe("connector seed", () => {
  it("seeds exactly the four supported platforms", () => {
    const platforms = CONNECTOR_SEED.map((c) => c.platform).sort();
    expect(platforms).toEqual(["trendradar", "web_search", "wechat", "x"]);
  });

  it("maps each platform to a stable connector id", () => {
    for (const p of ["x", "wechat", "web_search", "trendradar"] as const) {
      const id = connectorIdForPlatform(p);
      expect(id).toBeTruthy();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    }
  });

  it("resolves the trendradar connector that drives hotlist ingestion", () => {
    expect(connectorIdForPlatform("trendradar")).toBe(
      "00000000-0000-0000-0000-000000000004",
    );
  });
});
