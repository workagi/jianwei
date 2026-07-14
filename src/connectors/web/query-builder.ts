import type { WebSearchMonitorConfig } from "@/connectors/types";

export function buildSearchQuery(config: WebSearchMonitorConfig): string {
  const parts = [config.query];
  parts.push(...config.exactPhrases.map((phrase) => `"${phrase.replaceAll('"', "")}"`));
  parts.push(...config.excludedTerms.map((term) => `-${term.replaceAll(" ", "-")}`));
  parts.push(...config.includeDomains.map((domain) => `site:${domain}`));
  parts.push(...config.excludeDomains.map((domain) => `-site:${domain}`));
  return parts.filter(Boolean).join(" ");
}
