import type { PlatformType } from "@/connectors/types";
import { deriveItemClassification, type ContentTypeId } from "@/lib/item-tags";
import { passesTrendRadarReaderGate } from "@/lib/trendradar-interest-filter";

/**
 * Release regression floor shared by the CLI evaluator and the Vitest suite.
 * This is a measured floor for the current rule-based classifier, not a claim
 * that the rules are production-grade semantic classification. Raising it
 * requires improving the golden set and classifier together.
 */
export const CONTENT_RULE_MIN_ACCURACY = 0.64;
export const CONTENT_RULE_MIN_MACRO_F1 = 0.63;

export interface ContentRuleEvaluationCase {
  id: string;
  platform: PlatformType;
  authorName?: string | null;
  authorHandle?: string | null;
  title?: string | null;
  bodyText: string;
  expectedContentType?: ContentTypeId;
  requiredTopicTags?: string[];
  /** Legacy fixture name retained during the golden-set migration. */
  expectedTopicTags?: string[];
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
  return c.requiredTopicTags ?? c.expectedTopicTags ?? [];
}
function getForbiddenTags(c: ContentRuleEvaluationCase): string[] {
  return c.forbiddenTopicTags ?? [];
}

/**
 * Older golden-set rows used category labels in the topic-tag field. Runtime
 * topic tags are intentionally entity/topic oriented, so evaluate those
 * labels against the persisted content type instead of silently treating a
 * valid category expectation as a missing topic entity. Exact runtime tags
 * still win, which keeps this compatibility layer harmless for real topics.
 */
const SEMANTIC_TAG_CONTENT_TYPES: Record<string, ContentTypeId> = {
  "产品": "product_update",
  "产品动态": "product_update",
  "应用": "product_update",
  "模型": "model_release",
  "模型发布": "model_release",
  "大模型": "model_release",
  "行业": "industry_business",
  "行业商业": "industry_business",
  "论文": "research",
  "论文研究": "research",
  "教程": "tutorial",
  "实践教程": "tutorial",
  "政策": "policy_safety",
  "政策安全": "policy_safety",
  "安全": "policy_safety",
  "观点": "opinion",
  "观点解读": "opinion",
};

function matchesTopicExpectation(
  classification: ReturnType<typeof deriveItemClassification>,
  expected: string,
): boolean {
  if (classification.topicTags.includes(expected)) return true;
  const semanticType = SEMANTIC_TAG_CONTENT_TYPES[expected];
  return semanticType !== undefined && classification.contentType === semanticType;
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
      if (matchesTopicExpectation(classification, tag)) tagPassed += 1;
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
  let totalF1 = 0;
  let categoryCount = 0;
  for (const [cat, { tp, fp, fn }] of Object.entries(categoryMatrix)) {
    const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 0;
    const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : 0;
    const f1 = precision + recall > 0 ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4)) : 0;
    perCategory[cat] = { tp, fp, fn, precision, recall, f1 };
    totalF1 += f1;
    categoryCount += 1;
  }
  const macroF1 = categoryCount > 0
    ? Number((totalF1 / categoryCount).toFixed(4))
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
