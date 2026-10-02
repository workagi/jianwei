import { NextResponse } from "next/server";
import { TrendRadarMcpClient } from "@/connectors/trendradar/mcp-client";
import { TrendRadarConnector } from "@/connectors/trendradar/trendradar-connector";
import { BoundedFixedWindowLimiter } from "@/lib/bounded-fixed-window";
import { loginClientKey } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

type LatestPayload = {
  ok: true;
  news: Awaited<ReturnType<TrendRadarConnector["latestNews"]>>;
  rss: Awaited<ReturnType<TrendRadarConnector["latestRss"]>>;
  total: number;
};

let cached: { payload: LatestPayload; expiresAt: number } | undefined;
let inFlight: Promise<LatestPayload> | undefined;
const requestLimiter = new BoundedFixedWindowLimiter(10_000);

function positiveNumber(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(max, parsed) : fallback;
}

function requestAllowed(key: string, now = Date.now()): boolean {
  const limit = positiveNumber(process.env.TRENDRADAR_PUBLIC_REQUESTS_PER_MINUTE, 120, 10_000);
  return requestLimiter.allow(key, limit, 60_000, now);
}

async function loadLatest(): Promise<LatestPayload> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.payload;
  if (inFlight) return inFlight;

  const endpoint = process.env.TRENDRADAR_MCP_URL ?? "http://127.0.0.1:3333/mcp";
  const connector = new TrendRadarConnector(new TrendRadarMcpClient(endpoint));
  inFlight = (async () => {
    const [news, rss] = await Promise.all([
      connector.latestNews(30),
      connector.latestRss(30, 2),
    ]);
    const payload: LatestPayload = {
      ok: true,
      news,
      rss,
      total: news.length + rss.length,
    };
    const cacheSeconds = positiveNumber(process.env.TRENDRADAR_PUBLIC_CACHE_SECONDS, 20, 300);
    cached = { payload, expiresAt: Date.now() + cacheSeconds * 1_000 };
    return payload;
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

export async function GET(request: Request) {
  if (!requestAllowed(loginClientKey(request))) {
    return NextResponse.json(
      { ok: false, error: "TRENDRADAR_RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  try {
    const payload = await loadLatest();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "TRENDRADAR_UNKNOWN_ERROR",
    }, { status: 503 });
  }
}
