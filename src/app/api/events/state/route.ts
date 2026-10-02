import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAuth } from "@/lib/auth";
import { updateEventReaderState } from "@/lib/event-reader";

export const dynamic = "force-dynamic";
const stateInput = z.object({ eventId: z.uuid(), readRevision: z.number().int().nonnegative().optional(), followed: z.boolean().optional() })
  .refine(input => input.readRevision !== undefined || input.followed !== undefined);
export async function POST(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;
  const input = stateInput.safeParse(await req.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "事件状态参数无效" }, { status: 400 });
  const { eventId, ...state } = input.data;
  const result = await updateEventReaderState(eventId, state);
  if (result !== "ok") return NextResponse.json({ error: result === "not_found" ? "事件不存在" : "不能标记未展示的新版本" }, { status: result === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true });
}
