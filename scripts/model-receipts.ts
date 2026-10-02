import { randomUUID } from "node:crypto";
import { db, sql as client } from "../src/db";
import { modelReceipts, modelAttempts } from "../src/db/schema";
import { and, desc, eq, lt, sql } from "drizzle-orm";

async function main() {
  const [command = "list", key] = process.argv.slice(2);
  try {
    if (command === "list") {
      console.log(await db.select({ key: modelReceipts.key, provider: modelReceipts.provider, model: modelReceipts.model, status: modelReceipts.status, updatedAt: modelReceipts.updatedAt })
        .from(modelReceipts).orderBy(desc(modelReceipts.updatedAt)).limit(50));
    } else if (command === "retry" && /^[a-f0-9]{64}$/.test(key ?? "")) {
      // Explicit recovery fences a previous owner and preserves attempt history.
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('jianwei:model-budget'))`);
        const rows = await tx.update(modelReceipts).set({ status: "rejected", owner: randomUUID(), updatedAt: new Date() })
          .where(and(eq(modelReceipts.key, key), sql`${modelReceipts.status} in ('unknown', 'sending')`, lt(modelReceipts.updatedAt, new Date(Date.now() - 30 * 60_000))))
          .returning({ key: modelReceipts.key });
        if (!rows.length) throw new Error("只允许放行超过30分钟、结果不明的回执；不会改动成功结果或活跃请求。");
        await tx.update(modelAttempts).set({ status: "unknown", finishedAt: new Date() })
          .where(and(eq(modelAttempts.receiptKey, key), eq(modelAttempts.status, "sending")));
      });
      console.log("已放行此请求。再次执行对应补跑可能产生新的服务商费用。");
    } else throw new Error("Usage: tsx scripts/model-receipts.ts list | retry <receipt-key>");
  } finally { await client.end({ timeout: 5 }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
