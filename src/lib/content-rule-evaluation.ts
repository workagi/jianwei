import type { PlatformType } from "@/connectors/types";
import { deriveItemClassification, type ContentTypeId } from "@/lib/item-tags";
import { passesTrendRadarReaderGate } from "@/lib/trendradar-interest-filter";

export interface ContentRuleEvaluationCase {
  id: string;
  platform: PlatformType;
  authorName?: string | null;
  authorHandle?: string | null;
  title?: string | null;
  bodyText: string;
  expectedContentType?: ContentTypeId;
  requiredTopicTags?: string[];
  forbiddenTopicTags?: string[];
  expectedReaderVisible?: boolean;
  note?: string;
}

export interface ContentRuleEvaluationFailure {
  id: string;
  dimension: "content_type" | "required_tag" | "forbidden_tag" | "reader_gate";
  expected: string | boolean;
  actual: string | boolean | string[];
  note?: string;
}

export interface ContentRuleEvaluationReport {
  totalCases: number;
  /** Cases that didn't produce any testable assertion. */
  zeroAssertionCases: number;
  assertionCount: number;
  passedAssertions: number;
  accuracy: number;
  contentType: { assertions: number; passed: number; accuracy: number };
  topicTags: { assertions: number; passed: number; accuracy: number };
  readerGate: { assertions: number; passed: number; accuracy: number };
  /** Per-category precision / recall / F1 for content type classification. */
  perCategory: Record<string, { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }>;
  /** Overall macro-averaged F1 across all content types. */
  macroF1: number;
  failures: ContentRuleEvaluationFailure[];
}

function ratio(passed: number, total: number): number {
  return total === 0 ? 1 : Number((passed / total).toFixed(4));
}

function getRequiredTags(c: ContentRuleEvaluationCase): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (c as any).requiredTopicTags ?? (c as any).expectedTopicTags ?? [];
}
function getForbiddenTags(c: ContentRuleEvaluationCase): string[] {
  return c.forbiddenTopicTags ?? [];
}

export function evaluateContentRules(cases: ContentRuleEvaluationCase[]): ContentRuleEvaluationReport {
  const failures: ContentRuleEvaluationFailure[] = [];
  let typeAssertions = 0;
  let typePassed = 0;
  let tagAssertions = 0;
  let tagPassed = 0;
  let gateAssertions = 0;
  let gatePassed = 0;

  for (const testCase of cases) {
    const classification = deriveItemClassification({
      platform: testCase.platform,
      authorName: testCase.authorName ?? null,
      authorHandle: testCase.authorHandle ?? null,
      title: testCase.title ?? null,
      bodyText: testCase.bodyText,
      aiSummary: null,
    });

    if (testCase.expectedContentType && (testCase.expectedContentType as string) !== "?") {
      typeAssertions += 1;
      if (classification.contentType === testCase.expectedContentType) typePassed += 1;
      else failures.push({
        id: testCase.id,
        dimension: "content_type",
        expected: testCase.expectedContentType,
        actual: classification.contentType,
        note: testCase.note,
      });
    }

    for (const tag of getRequiredTags(testCase)) {
      tagAssertions += 1;
      if (classification.topicTags.includes(tag)) tagPassed += 1;
      else failures.push({
        id: testCase.id,
        dimension: "required_tag",
        expected: tag,
        actual: classification.topicTags,
        note: testCase.note,
      });
    }
    for (const tag of getForbiddenTags(testCase)) {
      tagAssertions += 1;
      if (!classification.topicTags.includes(tag)) tagPassed += 1;
      else failures.push({
        id: testCase.id,
        dimension: "forbidden_tag",
        expected: `not:${tag}`,
        actual: classification.topicTags,
        note: testCase.note,
      });
    }

    if (testCase.expectedReaderVisible !== undefined) {
      gateAssertions += 1;
      const visible = testCase.platform !== "trendradar" || passesTrendRadarReaderGate({
        title: testCase.title,
        bodyText: testCase.bodyText,
        authorName: testCase.authorName,
      });
      if (visible === testCase.expectedReaderVisible) gatePassed += 1;
      else failures.push({
        id: testCase.id,
        dimension: "reader_gate",
        expected: testCase.expectedReaderVisible,
        actual: visible,
        note: testCase.note,
      });
    }
  }

  // Per-category confusion matrix for content types
  const categoryMatrix: Record<string, { tp: number; fp: number; fn: number }> = {};
  for (const testCase of cases) {
    if (!testCase.expectedContentType || (testCase.expectedContentType as string) === "?") continue;
    const classification = deriveItemClassification({
      platform: testCase.platform,
      authorName: testCase.authorName ?? null,
      authorHandle: testCase.authorHandle ?? null,
      title: testCase.title ?? null,
      bodyText: testCase.bodyText,
      aiSummary: null,
    });
    const expected = testCase.expectedContentType;
    const predicted = classification.contentType;

    // True positive: predicted correctly
    if (predicted === expected) {
      if (!categoryMatrix[expected]) categoryMatrix[expected] = { tp: 0, fp: 0, fn: 0 };
      categoryMatrix[expected].tp += 1;
    } else {
      // False negative for expected class
      if (!categoryMatrix[expected]) categoryMatrix[expected] = { tp: 0, fp: 0, fn: 0 };
      categoryMatrix[expected].fn += 1;
      // False positive for predicted class
      if (!categoryMatrix[predicted]) categoryMatrix[predicted] = { tp: 0, fp: 0, fn: 0 };
      categoryMatrix[predicted].fp += 1;
    }
  }

  const perCategory: Record<string, { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }> = {};
  let totalPrecision = 0;
  let totalRecall = 0;
  let categoryCount = 0;
  for (const [cat, { tp, fp, fn }] of Object.entries(categoryMatrix)) {
    const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 0;
    const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : 0;
    const f1 = precision + recall > 0 ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4)) : 0;
    perCategory[cat] = { tp, fp, fn, precision, recall, f1 };
    totalPrecision += precision;
    totalRecall += recall;
    categoryCount += 1;
  }
  const macroF1 = categoryCount > 0
    ? Number(((2 * (totalPrecision / categoryCount) * (totalRecall / categoryCount)) / ((totalPrecision / categoryCount) + (totalRecall / categoryCount))).toFixed(4))
    : 0;

  // Warn about cases that produce zero assertions (likely missing expectations)
  let zeroAssertionCases = 0;
  for (const testCase of cases) {
    const hasContentType = testCase.expectedContentType != null;
    const hasTags = (getRequiredTags(testCase).length > 0) || (getForbiddenTags(testCase).length > 0);
    const hasGate = testCase.expectedReaderVisible !== undefined;
    if (!hasContentType && !hasTags && !hasGate) {
      zeroAssertionCases += 1;
    }
  }

  const assertionCount = typeAssertions + tagAssertions + gateAssertions;
  const passedAssertions = typePassed + tagPassed + gatePassed;
  return {
    totalCases: cases.length,
    zeroAssertionCases,
    assertionCount,
    passedAssertions,
    accuracy: ratio(passedAssertions, assertionCount),
    contentType: { assertions: typeAssertions, passed: typePassed, accuracy: ratio(typePassed, typeAssertions) },
    topicTags: { assertions: tagAssertions, passed: tagPassed, accuracy: ratio(tagPassed, tagAssertions) },
    readerGate: { assertions: gateAssertions, passed: gatePassed, accuracy: ratio(gatePassed, gateAssertions) },
    perCategory,
    macroF1,
    failures,
  };
}
