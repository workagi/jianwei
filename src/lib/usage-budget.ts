import { db } from "@/db";
import { usageLedger, usageReservations } from "@/db/schema";
import { and, eq, gt, gte, sql } from "drizzle-orm";

export type BudgetKind = "monthly_cost" | "daily_quantity";

export interface UsageBudgetReservation {
  idempotencyKey: string;
  scopeKey: string;
  connectorId: string;
  monitorId: string;
  metric: string;
  quantity: number;
  estimatedCostUsd: number;
  kind: BudgetKind;
  limit: number;
  exhaustedError: string;
}

type UsageBudgetDatabase = Pick<typeof db, "update">;

function reservationTtlMs(): number {
  const minutes = Number(process.env.BUDGET_RESERVATION_TTL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
}

function periodStart(kind: BudgetKind, now: Date): Date {
  const start = new Date(now);
  if (kind === "monthly_cost") start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * Reserve budget before an external request. The advisory transaction lock is
 * scoped to the configured budget, making read-check-reserve atomic across all
 * worker processes without requiring Redis.
 */
export async function reserveUsageBudget(
  reservation: UsageBudgetReservation,
  now = new Date(),
): Promise<"reserved" | "settled"> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${reservation.scopeKey}, 0))`);

    const [existing] = await tx
      .select({ status: usageReservations.status })
      .from(usageReservations)
      .where(eq(usageReservations.idempotencyKey, reservation.idempotencyKey))
      .limit(1);
    if (existing?.status === "settled") return "settled";
    if (existing?.status === "reserved") {
      await tx.update(usageReservations).set({
        expiresAt: new Date(now.getTime() + reservationTtlMs()),
        updatedAt: now,
      }).where(eq(usageReservations.idempotencyKey, reservation.idempotencyKey));
      return "reserved";
    }

    const start = periodStart(reservation.kind, now);
    const [committed] = reservation.kind === "monthly_cost"
      ? await tx
        .select({ total: sql<number>`coalesce(sum(${usageLedger.estimatedCost}), 0)` })
        .from(usageLedger)
        .where(and(
          eq(usageLedger.connectorId, reservation.connectorId),
          gte(usageLedger.occurredAt, start),
        ))
      : await tx
        .select({ total: sql<number>`coalesce(sum(${usageLedger.quantity}), 0)` })
        .from(usageLedger)
        .where(and(
          eq(usageLedger.metric, reservation.metric),
          gte(usageLedger.occurredAt, start),
        ));
    const [pending] = reservation.kind === "monthly_cost"
      ? await tx
        .select({ total: sql<number>`coalesce(sum(${usageReservations.estimatedCost}), 0)` })
        .from(usageReservations)
        .where(and(
          eq(usageReservations.connectorId, reservation.connectorId),
          eq(usageReservations.status, "reserved"),
          gte(usageReservations.createdAt, start),
          gt(usageReservations.expiresAt, now),
        ))
      : await tx
        .select({ total: sql<number>`coalesce(sum(${usageReservations.quantity}), 0)` })
        .from(usageReservations)
        .where(and(
          eq(usageReservations.metric, reservation.metric),
          eq(usageReservations.status, "reserved"),
          gte(usageReservations.createdAt, start),
          gt(usageReservations.expiresAt, now),
        ));

    const current = Number(committed?.total ?? 0) + Number(pending?.total ?? 0);
    const requested = reservation.kind === "monthly_cost"
      ? reservation.estimatedCostUsd
      : reservation.quantity;
    if (current >= reservation.limit || current + requested > reservation.limit) {
      throw new Error(reservation.exhaustedError);
    }

    await tx.insert(usageReservations).values({
      idempotencyKey: reservation.idempotencyKey,
      connectorId: reservation.connectorId,
      monitorId: reservation.monitorId,
      metric: reservation.metric,
      quantity: reservation.quantity,
      estimatedCost: String(reservation.estimatedCostUsd),
      status: "reserved",
      expiresAt: new Date(now.getTime() + reservationTtlMs()),
      updatedAt: now,
    }).onConflictDoUpdate({
      target: usageReservations.idempotencyKey,
      set: {
        connectorId: reservation.connectorId,
        monitorId: reservation.monitorId,
        metric: reservation.metric,
        quantity: reservation.quantity,
        estimatedCost: String(reservation.estimatedCostUsd),
        status: "reserved",
        expiresAt: new Date(now.getTime() + reservationTtlMs()),
        updatedAt: now,
      },
    });
    return "reserved";
  });
}

export async function settleUsageReservation(
  database: UsageBudgetDatabase,
  idempotencyKey: string | undefined,
  now = new Date(),
): Promise<void> {
  if (!idempotencyKey) return;
  await database.update(usageReservations).set({
    status: "settled",
    expiresAt: now,
    updatedAt: now,
  }).where(eq(usageReservations.idempotencyKey, idempotencyKey));
}

export async function releaseUsageReservation(
  database: UsageBudgetDatabase,
  idempotencyKey: string | undefined,
  now = new Date(),
): Promise<void> {
  if (!idempotencyKey) return;
  await database.update(usageReservations).set({
    status: "released",
    expiresAt: now,
    updatedAt: now,
  }).where(and(
    eq(usageReservations.idempotencyKey, idempotencyKey),
    eq(usageReservations.status, "reserved"),
  ));
}
