import { NextResponse } from "next/server";
import { requireWriteAuth } from "@/lib/auth";
import { backfillMissingSummaries } from "@/lib/summary-backfill";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    // Admin button only: fill true field gaps. Never auto-polish historical "rules" rows.
    const result = await backfillMissingSummaries(body.limit, { scope: "incomplete" });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: "补跑摘要/标签失败", detail: message }, { status: 500 });
  }
}
