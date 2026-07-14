import type { PlatformType } from "@/connectors/types";

/**
 * The `monitors` table has a NOT NULL FK to `connectors.connectorId`, and there
 * is exactly one connector per platform. We seed four deterministic rows with
 * fixed UUIDs so:
 *   1. The seed is idempotent across re-runs (upsert on the stable id).
 *   2. The API can resolve a connectorId from a platform without an extra query.
 */
export interface ConnectorSeed {
  id: string;
  platform: PlatformType;
  provider: string;
  name: string;
  enabled: boolean;
}

export const CONNECTOR_SEED: ConnectorSeed[] = [
  { id: "00000000-0000-0000-0000-000000000001", platform: "x", provider: "x_api", name: "X API（官方）", enabled: true },
  { id: "00000000-0000-0000-0000-000000000002", platform: "wechat", provider: "werss", name: "WeRSS 公众号", enabled: true },
  { id: "00000000-0000-0000-0000-000000000003", platform: "web_search", provider: "brave", name: "Brave Search", enabled: true },
  { id: "00000000-0000-0000-0000-000000000004", platform: "trendradar", provider: "trendradar", name: "TrendRadar 聚合", enabled: true },
];

export function connectorIdForPlatform(platform: PlatformType): string | undefined {
  return CONNECTOR_SEED.find((c) => c.platform === platform)?.id;
}
