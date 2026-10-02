import { eq } from "drizzle-orm";
import { db } from "@/db";
import { items } from "@/db/schema";
import { createDrizzleIngestRepository } from "@/ingestion/repositories";
import { documentContentHash } from "@/ingestion/content-revisions";
import { htmlDocumentText } from "./document-text";

/** Hydration follows the same revision and stale-input rules as normal ingestion. */
export async function writeFetchedWechatContent(itemId: string, expected: { contentHash: string; contentRevision: number }, result: { html?: string | null; provider?: string | null; status: string; errorCode?: string | null }) {
  return db.transaction(async tx => {
    const [current] = await tx.select().from(items).where(eq(items.id, itemId)).for("update");
    if (!current || current.contentHash !== expected.contentHash || current.contentRevision !== expected.contentRevision) return null;
    if (result.html) {
      const row = { ...current, bodyText: htmlDocumentText(result.html), contentHtml: result.html,
        contentProvider: result.provider ?? null, contentFetchStatus: result.status,
        contentFetchError: result.errorCode ?? null, contentFetchedAt: new Date(), contentObservedAt: new Date(),
        analysisStatus: "pending", analysisInputHash: null };
      row.contentHash = documentContentHash(row);
      await createDrizzleIngestRepository(tx, true).upsertItems([row]);
    } else {
      await tx.update(items).set({ contentFetchStatus: result.status, contentFetchError: result.errorCode ?? null,
        contentFetchedAt: new Date() }).where(eq(items.id, itemId));
    }
    const [saved] = await tx.select().from(items).where(eq(items.id, itemId));
    return saved;
  });
}
