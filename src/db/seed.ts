import { db } from "@/db";
import { connectors, monitors } from "@/db/schema";
import { CONNECTOR_SEED, connectorIdForPlatform } from "./connector-seed";

/**
 * Idempotently ensure the four baseline connectors exist. Run after migrations
 * (via `pnpm db:seed`). Uses fixed UUIDs from CONNECTOR_SEED so re-running
 * updates in place instead of duplicating rows.
 */
export async function seedConnectors(): Promise<void> {
  for (const c of CONNECTOR_SEED) {
    await db
      .insert(connectors)
      .values({ id: c.id, platform: c.platform, provider: c.provider, name: c.name, enabled: c.enabled })
      .onConflictDoUpdate({
        target: connectors.id,
        set: { platform: c.platform, provider: c.provider, name: c.name, enabled: c.enabled },
      });
  }
  console.log(`[seed] 已初始化 ${CONNECTOR_SEED.length} 个连接器`);
}

// Ensure a baseline TrendRadar monitor exists so the reader shows hotlist/RSS
// content out of the box. TrendRadar owns collection; 见微 only consumes
// its MCP output. This row is what drives the worker's trendradar branch.
const DEFAULT_TRENDRADAR_MONITOR_ID = "00000000-0000-0000-0000-0000000000a1";

export async function seedDefaultMonitors(): Promise<void> {
  const connectorId = connectorIdForPlatform("trendradar");
  if (!connectorId) {
    console.warn("[seed] 未找到 trendradar 连接器，跳过默认监控");
    return;
  }
  await db
    .insert(monitors)
    .values({
      id: DEFAULT_TRENDRADAR_MONITOR_ID,
      platform: "trendradar",
      connectorId,
      name: "TrendRadar 实时热榜",
      config: {},
      pollIntervalMinutes: 30,
    })
    .onConflictDoNothing();
  console.log("[seed] 默认 trendradar 监控已就绪");
}

// Self-run when invoked directly (e.g. `pnpm db:seed`), but not when imported
// by another module.
if (process.argv[1] && /seed\.ts$/.test(process.argv[1])) {
  seedConnectors()
    .then(() => seedDefaultMonitors())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[seed] 失败:", err);
      process.exit(1);
    });
}
