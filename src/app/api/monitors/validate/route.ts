import { NextResponse } from "next/server";
import {
  xMonitorSchema,
  wechatMonitorSchema,
  webSearchMonitorSchema,
  isWechatKeywordRuleConfig,
  type XMonitorConfig,
  type WechatMonitorConfig,
  type WebSearchMonitorConfig,
} from "@/connectors/types";
import {
  createRuntimeWebSearchConnector,
  createRuntimeWeRssConnector,
  createRuntimeXConnector,
} from "@/connectors/factory";
import { requireWriteAuth } from "@/lib/auth";
import { previewWechatKeywordRule } from "@/connectors/wechat/keyword-rule";

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
  const denied = requireWriteAuth(req);
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
    if (platform === "x") {
      const preview = await (await createRuntimeXConnector()).validate(parsed.data as XMonitorConfig);
      return NextResponse.json({ ok: true, preview });
    }
    if (platform === "web_search") {
      const config = parsed.data as WebSearchMonitorConfig;
      const preview = await (await createRuntimeWebSearchConnector(config.provider ?? "brave")).validate(config);
      return NextResponse.json({ ok: true, preview });
    }
    if (isWechatKeywordRuleConfig(parsed.data)) {
      const preview = await previewWechatKeywordRule(parsed.data);
      return NextResponse.json({ ok: true, preview });
    }
    const preview = await (await createRuntimeWeRssConnector()).validate(parsed.data as Extract<WechatMonitorConfig, { kind: "account" }>);
    return NextResponse.json({ ok: true, preview });
  } catch (err) {
    const message = err instanceof Error ? err.message : "VALIDATE_FAILED";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
