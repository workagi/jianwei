import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { modelAttempts, modelReceipts } from "@/db/schema";

type ReceiptStatus = "sending" | "received" | "rejected" | "unknown";
interface StoredReceipt { status: ReceiptStatus; owner: string; response?: string | null }
export interface ModelReceiptStore {
  claim(key: string, provider: string, model: string, limit: number): Promise<{ owner: string; response?: string }>;
  finish(key: string, owner: string, status: ReceiptStatus, response?: string, usage?: ModelUsage): Promise<void>;
}
interface ModelUsage { inputTokens?: number; outputTokens?: number; cost?: number }

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function usageOf(response: string): ModelUsage {
  try {
    const data = JSON.parse(response) as { usage?: Record<string, unknown> };
    const inputTokens = tokenCount(data.usage?.prompt_tokens ?? data.usage?.input_tokens);
    const outputTokens = tokenCount(data.usage?.completion_tokens ?? data.usage?.output_tokens);
    const inputPrice = process.env.SUMMARY_INPUT_COST_PER_1M_USD?.trim();
    const outputPrice = process.env.SUMMARY_OUTPUT_COST_PER_1M_USD?.trim();
    const knownPrices = inputPrice && outputPrice && Number.isFinite(Number(inputPrice))
      && Number.isFinite(Number(outputPrice)) && Number(inputPrice) >= 0 && Number(outputPrice) >= 0;
    const cost = knownPrices && inputTokens !== undefined && outputTokens !== undefined
      ? (inputTokens * Number(inputPrice) + outputTokens * Number(outputPrice)) / 1_000_000
      : undefined;
    return { inputTokens, outputTokens, cost };
  } catch { return {}; }
}

export function modelDailyRequestLimit(): number {
  const raw = process.env.MODEL_DAILY_REQUEST_LIMIT;
  if (raw === undefined || raw.trim() === "") return 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error("MODEL_BUDGET_INVALID");
  return value;
}

export function modelReceiptKey(provider: string, endpoint: string, body: unknown, account: string): string {
  // Bind cache identity to account without persisting the key or request body.
  return createHash("sha256").update(JSON.stringify([provider, endpoint, body, account])).digest("hex");
}

export const databaseModelReceiptStore: ModelReceiptStore = {
  async claim(key, provider, model, limit) {
    return db.transaction(async (tx) => {
      // One global model quota covers all providers, web routes and workers.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('jianwei:model-budget'))`);
      const [receipt] = await tx.select().from(modelReceipts).where(eq(modelReceipts.key, key));
      if (receipt?.status === "received" && receipt.response !== null) return { owner: receipt.owner, response: receipt.response };
      if (receipt?.status === "sending" || receipt?.status === "unknown") throw new Error("MODEL_RECEIPT_OUTCOME_UNKNOWN");
      const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(modelAttempts)
        .where(sql`${modelAttempts.startedAt} >= date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'`);
      if (Number(count.total) >= limit) throw new Error("MODEL_DAILY_BUDGET_EXHAUSTED");
      const owner = randomUUID();
      await tx.insert(modelReceipts).values({ key, provider, model, owner, status: "sending" })
        .onConflictDoUpdate({ target: modelReceipts.key, set: { owner, status: "sending", response: null, error: null, updatedAt: new Date() } });
      await tx.insert(modelAttempts).values({ id: owner, receiptKey: key, status: "sending" });
      return { owner };
    });
  },
  async finish(key, owner, status, response, usage = {}) {
    await db.transaction(async (tx) => {
      const updated = await tx.update(modelReceipts).set({ status, response: response ?? null, updatedAt: new Date() })
        .where(and(eq(modelReceipts.key, key), eq(modelReceipts.owner, owner))).returning({ key: modelReceipts.key });
      if (!updated.length) throw new Error("MODEL_RECEIPT_OWNER_LOST");
      await tx.update(modelAttempts).set({
        status, inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null,
        estimatedCost: usage.cost === undefined ? null : String(usage.cost), finishedAt: new Date(),
      }).where(eq(modelAttempts.id, owner));
    });
  },
};

/** Isolated deterministic store for tests; production always uses PostgreSQL. */
export function createMemoryModelReceiptStore(): ModelReceiptStore {
  const receipts = new Map<string, StoredReceipt>();
  const attempts: string[] = [];
  const day = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  return {
    async claim(key, _provider, _model, limit) {
      const row = receipts.get(key);
      if (row?.status === "received" && row.response != null) return { owner: row.owner, response: row.response };
      if (row?.status === "sending" || row?.status === "unknown") throw new Error("MODEL_RECEIPT_OUTCOME_UNKNOWN");
      if (attempts.filter((at) => at === day()).length >= limit) throw new Error("MODEL_DAILY_BUDGET_EXHAUSTED");
      const owner = randomUUID();
      receipts.set(key, { owner, status: "sending" });
      attempts.push(day());
      return { owner };
    },
    async finish(key, owner, status, response) {
      if (receipts.get(key)?.owner !== owner) throw new Error("MODEL_RECEIPT_OWNER_LOST");
      receipts.set(key, { owner, status, response });
    },
  };
}

let testStore = createMemoryModelReceiptStore();
export function resetModelReceiptsForTests(): void { testStore = createMemoryModelReceiptStore(); }

export class ModelHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) { super(`Model HTTP ${status}`); }
}

/** Save even malformed successful responses before business parsing. Never resend uncertain outcomes. */
export async function requestModelJson(input: {
  provider: string; model: string; endpoint: string; body: Record<string, unknown>;
  headers: Record<string, string>; account: string; signal?: AbortSignal;
}, store: ModelReceiptStore = process.env.NODE_ENV === "test" ? testStore : databaseModelReceiptStore): Promise<{ json: unknown; reused: boolean }> {
  input.signal?.throwIfAborted();
  const key = modelReceiptKey(input.provider, input.endpoint, input.body, input.account);
  const claim = await store.claim(key, input.provider, input.model, modelDailyRequestLimit());
  if (claim.response !== undefined) return { json: JSON.parse(claim.response), reused: true };
  let settled = false;
  try {
    // Cancellation after reserving but before sending has a known, unbilled outcome.
    if (input.signal?.aborted) {
      await store.finish(key, claim.owner, "rejected");
      settled = true;
      input.signal.throwIfAborted();
    }
    const response = await fetch(input.endpoint, { method: "POST", signal: input.signal, headers: input.headers, body: JSON.stringify(input.body) });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      const status = response.status >= 500 || response.status === 408 ? "unknown" : "rejected";
      await store.finish(key, claim.owner, status);
      settled = true;
      // Error text stays out of durable logs: providers can echo user input or credentials.
      throw new ModelHttpError(response.status, detail);
    }
    const raw = await response.text();
    await store.finish(key, claim.owner, "received", raw, usageOf(raw));
    settled = true;
    return { json: JSON.parse(raw), reused: false };
  } catch (error) {
    if (!settled) await store.finish(key, claim.owner, "unknown");
    throw error;
  }
}
