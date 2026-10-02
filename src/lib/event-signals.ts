import { z } from "zod";
import { claimStage } from "./event-claims";

export const eventSignalSchema = z.object({
  subject: z.string().trim().min(1).max(100),
  action: z.enum(["release", "availability", "pricing", "funding", "acquisition", "research", "policy"]),
  object: z.string().trim().min(1).max(100),
  version: z.string().trim().min(1).max(40).nullable().default(null),
  occurredOn: z.iso.date().nullable().default(null),
  stage: z.enum(["announced", "available", "restricted", "corrected", "unknown"]),
  evidence: z.string().trim().min(6).max(240),
  facts: z.array(z.object({
    aspect: z.enum(["price", "access", "capability", "license", "metric", "schedule"]),
    value: z.string().trim().min(1).max(100),
    evidence: z.string().trim().min(6).max(240),
  })).max(3).default([]),
});
export type EventSignal = z.infer<typeof eventSignalSchema>;

export function normalizeEventValue(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Validate model fields once at the analysis boundary; evidence must be quoted source text. */
export function parseEventSignal(value: unknown, sourceText: string): EventSignal | undefined {
  const result = eventSignalSchema.safeParse(value);
  if (!result.success) return;
  const source = normalizeEventValue(sourceText);
  if (!source.includes(normalizeEventValue(result.data.evidence))) return;
  const quotedStage = claimStage(result.data.evidence);
  if (result.data.stage === "available" && (quotedStage === "restricted" || quotedStage === "announced")) return;
  return { ...result.data, facts: result.data.facts.filter(fact => {
    if (!source.includes(normalizeEventValue(fact.evidence))) return false;
    // Preserve quoted numbers; extracting USD0 from a USD30 quote is not evidence.
    const numbers = (text: string) => (normalizeEventValue(text).replace(/(?<=\d),(?=\d)/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    const quoted = numbers(fact.evidence);
    return numbers(fact.value).every(value => quoted.includes(value));
  }) };
}

export function sameEventSubject(a: EventSignal, b: EventSignal): boolean {
  return normalizeEventValue(a.subject) === normalizeEventValue(b.subject)
    && normalizeEventValue(a.object) === normalizeEventValue(b.object)
    && normalizeEventValue(a.version ?? "") === normalizeEventValue(b.version ?? "");
}

export function sameEventOccurrence(a: EventSignal, b: EventSignal): boolean {
  return sameEventSubject(a, b) && a.action === b.action && a.stage === b.stage
    && !(a.occurredOn && b.occurredOn && a.occurredOn !== b.occurredOn);
}
