import { NextResponse } from "next/server";
import { z } from "zod";
import {
  defaultTrendRadarInterestConfig,
  loadTrendRadarInterestConfig,
  saveTrendRadarInterestConfig,
} from "@/lib/trendradar-interest-filter";
import { requireWriteAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const groupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  keywords: z.array(z.string().trim().min(1).max(300)).min(1).max(80),
});

const saveSchema = z.object({
  globalFilters: z.array(z.string().trim().min(1).max(200)).max(100),
  groups: z.array(groupSchema).min(1).max(30),
});

export async function GET(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;

  try {
    const config = await loadTrendRadarInterestConfig();
    return NextResponse.json({ ok: true, ...config });
  } catch (err) {
    const fallback = defaultTrendRadarInterestConfig();
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      ok: true,
      configPath: "",
      ...fallback,
      warning: `读取兴趣规则失败，已返回默认规则：${message}`,
    });
  }
}

export async function PUT(req: Request) {
  const denied = requireWriteAuth(req);
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
    const config = await saveTrendRadarInterestConfig(parsed.data);
    return NextResponse.json({ ok: true, ...config });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: "保存热榜兴趣规则失败", detail: message },
      { status: 500 },
    );
  }
}
