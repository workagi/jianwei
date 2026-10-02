import { createHash } from "node:crypto";
import { htmlDocumentText } from "@/lib/document-text";

const clean = (s: string | null | undefined) => (s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
export function documentContentHash(row: { title?: string | null; bodyText: string; platform?: string; contentHtml?: string | null }): string {
  const visible = row.contentHtml && row.platform !== "x" ? htmlDocumentText(row.contentHtml) : clean(row.bodyText);
  return createHash("sha256").update(JSON.stringify([clean(row.title), visible, row.platform === "x" ? clean(row.contentHtml) : ""])).digest("hex");
}

export interface ContentObservation {
  platform: string; sourceProvider?: string | null; upstreamId: string;
  title?: string | null; bodyText: string; contentHtml?: string | null;
  contentFetchStatus?: string | null;
  contentOwnerKey?: string | null;
}

/** A complete response from the owning collector may correct a shorter text.
 * Search snippets and cross-provider observations can only enrich it.
 */
export function decideContentMerge(previous: ContentObservation, incoming: ContentObservation) {
  const incomingKey = `${incoming.platform}:${incoming.sourceProvider || incoming.platform}:${incoming.upstreamId}`;
  const sameSource = previous.contentOwnerKey ? previous.contentOwnerKey === incomingKey : previous.platform === incoming.platform
    && (previous.sourceProvider || previous.platform) === (incoming.sourceProvider || incoming.platform)
    && previous.upstreamId === incoming.upstreamId;
  const complete = incoming.contentFetchStatus === "success"
    || (incoming.platform === "x" && incoming.sourceProvider === "x_official");
  const bodyWins = Boolean(incoming.bodyText.trim()) && (
    sameSource && complete || incoming.bodyText.trim().length > previous.bodyText.trim().length
  );
  const title = sameSource && incoming.title?.trim() ? incoming.title : previous.title || incoming.title;
  const bodyText = bodyWins ? incoming.bodyText : previous.bodyText;
  const htmlWins = Boolean(incoming.contentHtml?.trim()) && (sameSource && complete
    || !previous.contentHtml?.trim()
    || htmlDocumentText(incoming.contentHtml!).length > htmlDocumentText(previous.contentHtml ?? "").length);
  const contentHtml = htmlWins ? incoming.contentHtml : previous.contentHtml;
  const hash = documentContentHash({ ...previous, title, bodyText, contentHtml });
  const changed = hash !== documentContentHash(previous);
  const titleChanged = clean(title) !== clean(previous.title);
  return { title, bodyText, contentHtml, hash, changed, bodyWins, htmlWins,
    ownerKey: complete && (bodyWins || htmlWins) ? incomingKey : previous.contentOwnerKey,
    kind: sameSource && (titleChanged || complete && (previous.contentFetchStatus === "success" || incoming.sourceProvider === "x_official")) ? "source_revision" : "enrichment" };
}
