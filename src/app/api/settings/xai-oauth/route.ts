import { NextResponse } from "next/server";
import { requireWriteAuth } from "@/lib/auth";
import { disconnectXaiOAuth, getXaiOAuthStatus, pollXaiOAuth, startXaiOAuth } from "@/lib/xai-oauth";

export async function GET(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;
  return NextResponse.json({ ok: true, status: await getXaiOAuthStatus() });
}

export async function POST(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;
  try {
    const body = await req.json() as { action?: string };
    if (body.action === "start") return NextResponse.json({ ok: true, status: await startXaiOAuth() });
    if (body.action === "poll") return NextResponse.json({ ok: true, status: await pollXaiOAuth() });
    if (body.action === "disconnect") {
      await disconnectXaiOAuth();
      return NextResponse.json({ ok: true, status: await getXaiOAuthStatus() });
    }
    return NextResponse.json({ ok: false, error: "不支持的操作" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "XAI_OAUTH_FAILED";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
