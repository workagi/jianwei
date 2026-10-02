import { describe, expect, it } from "vitest";
import { groupPersistedEvents, isLikelySameEvent } from "@/lib/content-clustering";
import { planEventAssignments, type EventCandidate } from "@/lib/event-projection";

function item(id: string, source: string, title: string, eventId?: string): EventCandidate {
  return { id, source, title, eventId, platform: "web_search", excerpt: "一个事件的完整摘要内容", tags: ["OpenAI", "模型"], score: 80, whyKept: "OpenAI 发布了提供明确变化的新模型版本", date: "2026-10-02T09:00:00Z" };
}
describe("persistent event identity", () => {
  it("rejects different product versions despite almost identical headlines", () => {
    expect(isLikelySameEvent(item("a", "A", "OpenAI 发布 GPT-5.1 模型，提升推理能力"), item("b", "B", "OpenAI 发布 GPT-5.2 模型，提升推理能力"))).toBe(false);
  });
  it("preserves existing and manual identities when new reports arrive", () => {
    const a = { ...item("a", "A", "OpenAI 发布 GPT-5.1 模型，提升推理能力", "event-a"), manual: true };
    const b = item("b", "B", "OpenAI 发布 GPT-5.1 模型，提升推理能力");
    expect(planEventAssignments([a, b])).toEqual([{ itemId: "b", eventId: "event-a", title: a.title }]);
  });
  it("reads saved grouping without clustering unassigned documents", () => {
    const a = item("a", "A", "OpenAI 发布 GPT-5.1 模型，提升推理能力");
    const b = item("b", "B", a.title);
    expect(groupPersistedEvents([a, b])).toHaveLength(2);
    expect(groupPersistedEvents([{ ...a, eventId: "shared" }, { ...b, eventId: "shared" }])).toHaveLength(1);
  });
});
