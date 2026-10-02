import { describe, expect, it } from "vitest";
import { readerHref } from "@/lib/reader-navigation";

describe("reader navigation", () => {
  it("preserves all selected monitors across navigation", () => {
    const url = new URL(readerHref({ view: "featured", monitor: ["x-task", "web-task"] }, { topic: "MCP" }), "http://localhost");
    expect(url.searchParams.getAll("monitor")).toEqual(["x-task", "web-task"]);
    expect(new URL(readerHref({ monitor: ["x-task"] }, { monitor: undefined }), "http://localhost").searchParams.has("monitor")).toBe(false);
  });
  it("preserves search, task and follow scope when opening or clearing a topic", () => {
    const state = { view: "changes", q: "API", monitor: "task-id", followed: "1", topic: "Agent" };
    const opened = new URL(readerHref(state, { topic: "MCP" }), "http://localhost");
    expect(Object.fromEntries(opened.searchParams)).toEqual({ ...state, topic: "MCP" });
    const cleared = new URL(readerHref(state, { topic: undefined }), "http://localhost");
    expect(Object.fromEntries(cleared.searchParams)).toEqual({ view: "changes", q: "API", monitor: "task-id", followed: "1" });
  });
});
