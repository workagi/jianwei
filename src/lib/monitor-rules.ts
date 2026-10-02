import type { MonitorRules } from "@/lib/content-retention";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Convert persisted monitor config into the shared Gate/Rank rule model. */
export function extractMonitorRulesFromConfig(
  config: Record<string, unknown>,
): MonitorRules | undefined {
  const keywords = stringArray(config.keywords);
  const requiredKeywords = stringArray(config.requiredKeywords);
  const excludeKeywords = stringArray(config.excludeKeywords);
  const contentTypeFilters = stringArray(config.contentTypeFilters);
  const topicFilters = stringArray(config.topicFilters);
  if (
    !keywords.length
    && !requiredKeywords.length
    && !excludeKeywords.length
    && !contentTypeFilters.length
    && !topicFilters.length
  ) {
    return undefined;
  }
  return {
    keywords,
    requiredKeywords,
    excludeKeywords,
    contentTypeFilters,
    topicFilters,
  };
}
