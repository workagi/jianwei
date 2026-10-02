import { randomUUID } from "node:crypto";
import { db, sql as client } from "../src/db";
import { contentEvents, eventItems, items } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";
import { refreshEventProjection } from "../src/lib/event-projection";

async function main() {
  const [command = "refresh", itemId] = process.argv.slice(2);
  try {
    if (command === "refresh") console.log(`已保存 ${await refreshEventProjection()} 条事件归属。`);
    else if (command === "split" && /^[a-f0-9-]{36}$/i.test(itemId ?? "")) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('jianwei:event-projection'))`);
        const [doc] = await tx.select({ title: items.title, translatedTitle: items.translatedTitle }).from(items).where(eq(items.id, itemId));
        if (!doc) throw new Error("内容不存在");
        const eventId = randomUUID();
        await tx.insert(contentEvents).values({ id: eventId, title: doc.translatedTitle || doc.title || "人工拆分事件", ruleVersion: "manual" });
        await tx.insert(eventItems).values({ itemId, eventId, manual: true }).onConflictDoUpdate({ target: eventItems.itemId,
          set: { eventId, manual: true, sourceRevision: 0, signalFingerprint: null } });
        console.log(`内容已拆到独立事件 ${eventId}，自动刷新不会覆盖。`);
      });
      await refreshEventProjection();
    } else throw new Error("Usage: tsx scripts/events.ts refresh | split <item-id>");
  } finally { await client.end({ timeout: 5 }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
