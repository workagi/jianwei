import { createHash } from "node:crypto";
import { conflictingEventIdentity, eventTitleSimilarity, MAX_EVENT_DISTANCE_MS, type ClusterableReaderItem } from "./content-clustering";
import { normalizeEventValue, sameEventOccurrence, sameEventSubject, type EventSignal } from "./event-signals";

import { claimStage, STAGE_LABELS } from "./event-claims";
export { claimStage } from "./event-claims";

function availabilityDate(signal?: EventSignal | null): string | null {
  return signal?.action === "availability" && signal.occurredOn
    && ["announced", "available", "restricted"].includes(signal.stage) ? signal.occurredOn : null;
}

/** Join progress directly to the root using source-backed identity, or explicit
 * title versions when structured fields are absent. Similarity is not verification.
 */
export function canJoinEventStory(root: ClusterableReaderItem, incoming: ClusterableReaderItem): boolean {
  const age = Date.parse(incoming.date) - Date.parse(root.date);
  if (!Number.isFinite(age) || age < 0) return false;
  if (root.followed && root.eventSignal?.version && incoming.eventSignal
    && sameEventSubject(root.eventSignal, incoming.eventSignal)
    && (availabilityDate(incoming.eventSignal) || incoming.eventSignal.stage === "corrected")) return true;
  if (age > 14 * 86400_000) return false;
  if (root.eventSignal && incoming.eventSignal) {
    const a = root.eventSignal, b = incoming.eventSignal;
    if (!sameEventSubject(a, b)) return false;
    if (availabilityDate(b)) return true;
    if (a.action === b.action && a.stage === b.stage) return age <= MAX_EVENT_DISTANCE_MS && sameEventOccurrence(a, b);
    return Boolean(a.version || (a.occurredOn && a.occurredOn === b.occurredOn));
  }
  const a = claimStage(root.title), b = claimStage(incoming.title);
  if (a === "unknown" || b === "unknown" || a === b || conflictingEventIdentity(root.title, incoming.title)) return false;
  const versions = (s: string): string[] => s.normalize("NFKC").toLowerCase().match(/[a-z][a-z0-9-]*[ -]+v?\d+(?:\.\d+)+|[a-z][a-z0-9-]*-\d+(?:\.\d+)*/g) ?? [];
  if (!versions(root.title).some(v => versions(incoming.title).includes(v))) return false;
  return eventTitleSimilarity(root.title, incoming.title) >= 0.58;
}

export function developmentInput(input: {
  itemId: string; sourceRevision: number; projectedRevision: number;
  title: string; bodyText: string; changeKind?: string | null; eventSignal?: EventSignal | null;
}) {
  const revised = input.projectedRevision > 0 && input.sourceRevision > input.projectedRevision;
  // Enrichment refreshes derived analysis but is not advertised as a factual change.
  if (revised && input.changeKind === "enrichment") return null;
  const stage = input.eventSignal?.stage ?? claimStage(input.title);
  const date = availabilityDate(input.eventSignal);
  return {
    developmentKey: revised ? `revision:${input.itemId}:${input.sourceRevision}` : date ? `availability:${stage}:${date}` : `stage:${stage}`,
    kind: revised ? "revision" : stage,
    label: revised ? "原文已修订，请核对变化" : STAGE_LABELS[stage],
    title: input.title, evidence: revised ? input.bodyText.trim().slice(0, 500) : input.eventSignal?.evidence ?? input.bodyText.trim().slice(0, 500),
  };
}

export interface DevelopmentHistory { developmentKey: string; eventRevision: number }

/** Dated availability compares the latest state, rather than every state ever seen.
 * Same-state confirmations and late historical reports are stored without a notification.
 */
export function selectFreshDevelopments(inputs: ReturnType<typeof developmentInputs>, history: DevelopmentHistory[]) {
  const known = new Set(history.map(row => row.developmentKey));
  const dated = history.filter(row => row.developmentKey.startsWith("availability:"))
    .sort((a, b) => b.developmentKey.split(":")[2].localeCompare(a.developmentKey.split(":")[2]) || b.eventRevision - a.eventRevision)[0];
  const previous = dated ?? history.filter(row => /^stage:(announced|available|restricted)$/.test(row.developmentKey))
    .sort((a, b) => b.eventRevision - a.eventRevision)[0];
  return inputs.filter(input => !known.has(input.developmentKey)).map(input => {
    if (!input.developmentKey.startsWith("availability:")) return { ...input, notify: true };
    const [, stage, date] = input.developmentKey.split(":");
    return { ...input, notify: (!previous || previous.developmentKey.split(":")[1] !== stage)
      && (!dated || date >= dated.developmentKey.split(":")[2]) };
  });
}

const ASPECT_LABELS = { price: "价格", access: "开放范围", capability: "能力", license: "许可", metric: "指标", schedule: "时间安排" };
export function developmentInputs(input: Parameters<typeof developmentInput>[0]) {
  const primary = developmentInput(input);
  const facts = (input.eventSignal?.facts ?? []).map(fact => ({
    developmentKey: `fact:${fact.aspect}:${createHash("sha256").update(normalizeEventValue(fact.value)).digest("hex")}`,
    kind: "fact", label: `材料新增或不同的${ASPECT_LABELS[fact.aspect]}信息，请核对`,
    title: input.title, evidence: fact.evidence,
  }));
  return [...new Map([...(primary ? [primary] : []), ...facts].map(row => [row.developmentKey, row])).values()];
}
