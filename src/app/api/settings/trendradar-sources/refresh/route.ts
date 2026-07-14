import { NextResponse } from "next/server";
import { requireWriteAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REFRESH_URL = process.env.TRENDRADAR_REFRESH_URL ?? "http://trendradar-refresh:8090/refresh";
const REFRESH_TOKEN = process.env.TRENDRADAR_REFRESH_TOKEN ?? "";

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;

  try {
    const response = await fetch(REFRESH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...(REFRESH_TOKEN ? { Authorization: `Bearer ${REFRESH_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      exitCode?: number;
      logTail?: string;
    };

    if (!response.ok || !payload.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: payload.error ?? "TrendRadar 刷新失败",
          exitCode: payload.exitCode,
          logTail: payload.logTail,
        },
        { status: response.status === 200 ? 500 : response.status },
      );
    }

    return NextResponse.json({
      ok: true,
      message: "TrendRadar 已完成一次立即采集。",
      exitCode: payload.exitCode,
      logTail: payload.logTail,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        ok: false,
        error: "无法连接 TrendRadar 刷新服务",
        detail: message,
      },
      { status: 502 },
    );
  }
}
