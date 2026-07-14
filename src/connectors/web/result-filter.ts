import type { NormalizedItem, WebSearchMonitorConfig } from "@/connectors/types";

const ENGLISH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "is",
  "news",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalizedDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
}

function textOf(item: NormalizedItem): string {
  return normalize([item.title, item.text, item.authorName, item.canonicalUrl].filter(Boolean).join(" "));
}

function queryTokens(query: string): string[] {
  return query
    .replace(/[“”"']/g, " ")
    .split(/[\s,，、|/]+/)
    .map((part) => normalize(part))
    .filter((part) => part.length >= 2 && !part.startsWith("-") && !part.startsWith("site:") && !ENGLISH_STOP_WORDS.has(part));
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(normalize(term)));
}

function containsAll(text: string, terms: string[]): boolean {
  return terms.every((term) => text.includes(normalize(term)));
}

export function filterSearchItems(
  items: NormalizedItem[],
  config: WebSearchMonitorConfig,
): { items: NormalizedItem[]; dropped: number } {
  const exactPhrases = config.exactPhrases.map(normalize).filter(Boolean);
  const excludedTerms = config.excludedTerms.map(normalize).filter(Boolean);
  const tokens = queryTokens(config.query);

  const filtered = items.filter((item) => {
    const hostname = hostnameOf(item.canonicalUrl);
    if (config.includeDomains.length > 0 && !config.includeDomains.some((domain) => domainMatches(hostname, domain))) {
      return false;
    }
    if (config.excludeDomains.some((domain) => domainMatches(hostname, domain))) {
      return false;
    }

    const haystack = textOf(item);
    if (containsAny(haystack, excludedTerms)) return false;

    if (exactPhrases.length > 0) {
      return containsAll(haystack, exactPhrases);
    }

    if (tokens.length > 0) {
      return containsAny(haystack, tokens);
    }

    return true;
  });

  return { items: filtered, dropped: items.length - filtered.length };
}
