import { NextResponse } from "next/server";
import { z } from "zod";
import { loadTrendRadarSourcesConfig, saveTrendRadarSourcesConfig } from "@/lib/trendradar-config";
import { requireWriteAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const platformSourceSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  expectedDomain: z.string().trim().max(120).optional(),
  enabled: z.boolean(),
  custom: z.boolean().optional(),
});

const rssFeedSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  url: z.url(),
  enabled: z.boolean(),
  maxAgeDays: z.number().int().min(0).max(365).optional(),
});

const saveSchema = z.object({
  platformsEnabled: z.boolean(),
  rssEnabled: z.boolean(),
  platformSources: z.array(platformSourceSchema).min(1),
  rssFeeds: z.array(rssFeedSchema),
});

export async function GET(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;

  try {
    const config = await loadTrendRadarSourcesConfig();
    return NextResponse.json({ ok: true, ...config });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: "读取 TrendRadar 来源配置失败", detail: message },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "配置校验失败", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }

  try {
    const config = await saveTrendRadarSourcesConfig(parsed.data);
    return NextResponse.json({
      ok: true,
      ...config,
      message: "已保存。TrendRadar 下一轮采集会读取新配置；如需立即生效，请重启 trendradar / trendradar-mcp 服务。",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: "保存 TrendRadar 来源配置失败", detail: message },
      { status: 500 },
    );
  }
}
