import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryModelReceiptStore, modelReceiptKey, requestModelJson } from "@/lib/model-receipts";

const input = { provider: "test", model: "small", endpoint: "http://model.test/chat", body: { model: "small", messages: ["content"] }, headers: {}, account: "test-account" };
afterEach(() => { vi.unstubAllGlobals(); delete process.env.MODEL_DAILY_REQUEST_LIMIT; });

describe("durable model request protocol", () => {
  it("reuses the paid response when business work is retried", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ answer: "saved" })));
    vi.stubGlobal("fetch", fetch);
    const store = createMemoryModelReceiptStore();
    expect((await requestModelJson(input, store)).reused).toBe(false);
    expect(await requestModelJson(input, store)).toEqual({ json: { answer: "saved" }, reused: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("shares the daily ceiling across providers and permits cache hits after exhaustion", async () => {
    process.env.MODEL_DAILY_REQUEST_LIMIT = "1";
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const store = createMemoryModelReceiptStore();
    await requestModelJson(input, store);
    await expect(requestModelJson({ ...input, provider: "other" }, store)).rejects.toThrow("MODEL_DAILY_BUDGET_EXHAUSTED");
    expect((await requestModelJson(input, store)).reused).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not resend a timeout with an uncertain billing outcome", async () => {
    const fetch = vi.fn(async () => { throw new Error("network timeout"); });
    vi.stubGlobal("fetch", fetch);
    const store = createMemoryModelReceiptStore();
    await expect(requestModelJson(input, store)).rejects.toThrow("network timeout");
    await expect(requestModelJson(input, store)).rejects.toThrow("MODEL_RECEIPT_OUTCOME_UNKNOWN");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("prevents concurrent owners sending the same request", async () => {
    let finish!: () => void;
    vi.stubGlobal("fetch", vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return new Response("{}"); }));
    const store = createMemoryModelReceiptStore();
    const first = requestModelJson(input, store);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(requestModelJson(input, store)).rejects.toThrow("MODEL_RECEIPT_OUTCOME_UNKNOWN");
    finish();
    await first;
  });
  it("persists malformed successful responses before parsing", async () => {
    const fetch = vi.fn(async () => new Response("invalid json"));
    vi.stubGlobal("fetch", fetch);
    const store = createMemoryModelReceiptStore();
    await expect(requestModelJson(input, store)).rejects.toThrow();
    await expect(requestModelJson(input, store)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("binds identity to model, prompt, endpoint and account", () => {
    const key = modelReceiptKey(input.provider, input.endpoint, input.body, input.account);
    expect(modelReceiptKey(input.provider, input.endpoint, { ...input.body, model: "large" }, input.account)).not.toBe(key);
    expect(modelReceiptKey(input.provider, input.endpoint, { ...input.body, messages: ["new prompt"] }, input.account)).not.toBe(key);
    expect(modelReceiptKey(input.provider, "http://other.test", input.body, input.account)).not.toBe(key);
    expect(modelReceiptKey(input.provider, input.endpoint, input.body, "other-account")).not.toBe(key);
  });
});
