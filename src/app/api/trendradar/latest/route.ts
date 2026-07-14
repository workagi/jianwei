import { NextResponse } from "next/server";
import { TrendRadarMcpClient } from "@/connectors/trendradar/mcp-client";
import { TrendRadarConnector } from "@/connectors/trendradar/trendradar-connector";

export const dynamic = "force-dynamic";

export async function GET() {
  const endpoint = process.env.TRENDRADAR_MCP_URL ?? "http://127.0.0.1:3333/mcp";
  const connector = new TrendRadarConnector(new TrendRadarMcpClient(endpoint));
  try {
    const [news, rss] = await Promise.all([connector.latestNews(30), connector.latestRss(30, 2)]);
    return NextResponse.json({ ok: true, news, rss, total: news.length + rss.length });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "TRENDRADAR_UNKNOWN_ERROR",
    }, { status: 503 });
  }
}
