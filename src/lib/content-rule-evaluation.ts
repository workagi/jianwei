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
  assertionCount: number;
  passedAssertions: number;
  accuracy: number;
  contentType: { assertions: number; passed: number; accuracy: number };
  topicTags: { assertions: number; passed: number; accuracy: number };
  readerGate: { assertions: number; passed: number; accuracy: number };
  failures: ContentRuleEvaluationFailure[];
}

function ratio(passed: number, total: number): number {
  return total === 0 ? 1 : Number((passed / total).toFixed(4));
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

    for (const tag of testCase.requiredTopicTags ?? []) {
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
    for (const tag of testCase.forbiddenTopicTags ?? []) {
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

  const assertionCount = typeAssertions + tagAssertions + gateAssertions;
  const passedAssertions = typePassed + tagPassed + gatePassed;
  return {
    totalCases: cases.length,
    assertionCount,
    passedAssertions,
    accuracy: ratio(passedAssertions, assertionCount),
    contentType: { assertions: typeAssertions, passed: typePassed, accuracy: ratio(typePassed, typeAssertions) },
    topicTags: { assertions: tagAssertions, passed: tagPassed, accuracy: ratio(tagPassed, tagAssertions) },
    readerGate: { assertions: gateAssertions, passed: gatePassed, accuracy: ratio(gatePassed, gateAssertions) },
    failures,
  };
}
