import { createHash } from "node:crypto";
import type { NormalizedItem } from "@/connectors/types";

const TRACKING_PARAMETERS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "ref", "ref_src",
];

export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  for (const key of TRACKING_PARAMETERS) url.searchParams.delete(key);
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

/**
 * Prefer a stable, content-addressed id for WeChat articles.
 * Historical rows used the `/s/<slug>` segment; WeRSS list ids like
 * `mpId-aid_1` change shape across versions and otherwise collide with the
 * unique `canonical_url` index when the same article is re-ingested.
 */
export function wechatStableUpstreamId(articleUrl: string | undefined, fallbackId?: string): string | undefined {
  if (articleUrl) {
    try {
      const path = new URL(articleUrl).pathname;
      const match = /\/s\/([A-Za-z0-9_-]+)/.exec(path);
      if (match?.[1]) return match[1];
    } catch {
      // fall through
    }
  }
  if (fallbackId?.trim()) return fallbackId.trim();
  return undefined;
}

export function contentFingerprint(item: NormalizedItem): string {
  const day = item.publishedAt.toISOString().slice(0, 10);
  const value = [item.title ?? "", item.text, item.authorHandle ?? item.authorName ?? "", day]
    .join("|")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(value).digest("hex");
}

export function dedupeKey(item: NormalizedItem): string {
  if (item.upstreamId) return `${item.platform}:id:${item.upstreamId}`;
  if (item.canonicalUrl) return `url:${canonicalizeUrl(item.canonicalUrl)}`;
  return `hash:${contentFingerprint(item)}`;
}
