import { NextResponse } from "next/server";
import {
  xMonitorSchema,
  wechatMonitorSchema,
  webSearchMonitorSchema,
} from "@/connectors/types";
import { requireWriteAuth } from "@/lib/auth";
import { createRuntimeSourceProvider } from "@/sources/registry";
import { validateWithProvider } from "@/sources/types";

export const dynamic = "force-dynamic";

const SCHEMA_MAP = {
  x: xMonitorSchema,
  wechat: wechatMonitorSchema,
  web_search: webSearchMonitorSchema,
} as const;

type SupportedPlatform = keyof typeof SCHEMA_MAP;

/**
 * Validate a monitor config against the source and return a preview (display
 * name + sample items). Requires the matching provider credentials to be set;
 * without them the connector surfaces an auth error that we forward to the UI.
 */
export async function POST(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;

  let body: { platform?: string; config?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "无效的 JSON 请求体" }, { status: 400 });
  }

  const { platform, config } = body;
  if (typeof platform !== "string" || !(platform in SCHEMA_MAP)) {
    return NextResponse.json({ ok: false, error: `不支持的平台: ${platform ?? "（空）"}` }, { status: 400 });
  }

  const schema = SCHEMA_MAP[platform as SupportedPlatform];
  const parsed = schema.safeParse(config ?? {});
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "配置校验失败", detail: parsed.error.flatten() }, { status: 422 });
  }

  try {
    const normalizedConfig = parsed.data as Record<string, unknown>;
    const provider = await createRuntimeSourceProvider(platform as SupportedPlatform, normalizedConfig);
    const preview = await validateWithProvider(provider, normalizedConfig);
    return NextResponse.json({ ok: true, preview });
  } catch (err) {
    const message = err instanceof Error ? err.message : "VALIDATE_FAILED";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
