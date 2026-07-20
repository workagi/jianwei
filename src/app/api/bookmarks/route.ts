import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookmarks, items } from "@/db/schema";
import { requireWriteAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function parseItemId(req: Request): Promise<string> {
  const fromQuery = new URL(req.url).searchParams.get("itemId")?.trim();
  if (fromQuery) return fromQuery;
  try {
    const body = await req.json() as { itemId?: unknown };
    return typeof body.itemId === "string" ? body.itemId.trim() : "";
  } catch {
    return "";
  }
}

export async function POST(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;
  const itemId = await parseItemId(req);
  if (!itemId) return NextResponse.json({ ok: false, error: "缺少 itemId" }, { status: 400 });

  const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, itemId)).limit(1);
  if (!item) return NextResponse.json({ ok: false, error: "内容不存在" }, { status: 404 });

  await db.insert(bookmarks).values({ itemId }).onConflictDoNothing();
  return NextResponse.json({ ok: true, itemId, bookmarked: true });
}

export async function DELETE(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;
  const itemId = await parseItemId(req);
  if (!itemId) return NextResponse.json({ ok: false, error: "缺少 itemId" }, { status: 400 });

  await db.delete(bookmarks).where(eq(bookmarks.itemId, itemId));
  return NextResponse.json({ ok: true, itemId, bookmarked: false });
}
