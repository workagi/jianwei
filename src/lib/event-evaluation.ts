import { z } from "zod";
import { isLikelySameEvent, type ClusterableReaderItem } from "@/lib/content-clustering";
import { eventSignalSchema } from "@/lib/event-signals";

const reportSchema = z.object({
  title: z.string().min(1),
  source: z.string().min(1),
  platform: z.enum(["x", "wechat", "web_search", "trendradar"]),
  date: z.string(),
  tags: z.array(z.string()).default([]),
  url: z.url().optional(),
  eventSignal: eventSignalSchema.optional(),
});

export const eventEvaluationCaseSchema = z.object({
  id: z.string().min(1),
  split: z.enum(["development", "holdout"]),
  provenance: z.enum(["synthetic", "observed"]),
  signalOrigin: z.enum(["annotated", "model"]).optional(),
  a: reportSchema,
  b: reportSchema,
  expected: z.enum(["same_event", "separate"]),
  note: z.string().optional(),
});

export type EventEvaluationCase = z.infer<typeof eventEvaluationCaseSchema>;

/** Validate every row, including excluded splits, so bad labels never silently disappear. */
export function parseEventEvaluationCases(input: unknown): EventEvaluationCase[] {
  const cases = z.array(eventEvaluationCaseSchema).min(1).parse(input);
  const seen = new Set<string>();
  for (const row of cases) {
    if (seen.has(row.id)) throw new Error(`Duplicate event case id: ${row.id}`);
    seen.add(row.id);
  }
  return cases;
}

function asReaderItem(report: EventEvaluationCase["a"], id: string): ClusterableReaderItem {
  return { ...report, id, excerpt: "", score: 0, whyKept: "" };
}

export function evaluateEventPairs(cases: EventEvaluationCase[], split: "all" | "development" | "holdout" = "all") {
  const selected = split === "all" ? cases : cases.filter((row) => row.split === split);
  if (!selected.length) throw new Error(`No event cases for split: ${split}`);
  const confusion = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  const failures: Array<{ id: string; expected: string; actual: string; note?: string }> = [];
  for (const row of selected) {
    const actual = isLikelySameEvent(asReaderItem(row.a, `${row.id}:a`), asReaderItem(row.b, `${row.id}:b`));
    const expected = row.expected === "same_event";
    if (actual && expected) confusion.truePositive += 1;
    else if (actual) confusion.falsePositive += 1;
    else if (expected) confusion.falseNegative += 1;
    else confusion.trueNegative += 1;
    if (actual !== expected) failures.push({ id: row.id, expected: row.expected, actual: actual ? "same_event" : "separate", note: row.note });
  }
  const ratio = (numerator: number, denominator: number) => denominator === 0 ? null : numerator / denominator;
  const { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn } = confusion;
  return {
    scope: selected.some(row => row.a.eventSignal || row.b.eventSignal) ? "pairwise_event_identity" : "pairwise_title_rules",
    signalOrigins: {
      annotated: selected.filter(row => row.signalOrigin === "annotated").length,
      model: selected.filter(row => row.signalOrigin === "model").length,
    },
    split,
    cases: selected.length,
    provenance: {
      synthetic: selected.filter((row) => row.provenance === "synthetic").length,
      observed: selected.filter((row) => row.provenance === "observed").length,
    },
    confusion,
    accuracy: ratio(tp + tn, selected.length),
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    f1: ratio(2 * tp, 2 * tp + fp + fn),
    falseMergeRate: ratio(fp, fp + tn),
    failures,
  };
}
