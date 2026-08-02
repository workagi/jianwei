import { NextResponse } from "next/server";
import { sql, like, desc, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { runtimeHealth } from "@/db/schema";
import { deriveWorkerHealthSummary, selectWorkerHeartbeats } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    const heartbeats = await db
      .select({
        service: runtimeHealth.service,
        status: runtimeHealth.status,
        lastHeartbeatAt: runtimeHealth.lastHeartbeatAt,
      })
      .from(runtimeHealth)
      .where(or(eq(runtimeHealth.service, "worker"), like(runtimeHealth.service, "worker:%")))
      .orderBy(desc(runtimeHealth.lastHeartbeatAt));
    const summary = deriveWorkerHealthSummary(selectWorkerHeartbeats(heartbeats), {
      staleAfterSeconds: Number(process.env.WORKER_HEALTHCHECK_STALE_SECONDS) || 300,
    });
    // A degraded worker is alive and should not be restarted by Docker, but
    // callers can distinguish it from a fully ready worker in the payload.
    const ok = summary.state === "ok" || summary.state === "degraded";
    const ready = summary.state === "ok";
    return NextResponse.json(
      {
        ok,
        ready,
        database: "ok",
        worker: summary.state,
        workerLastHeartbeatAt: summary.freshestHeartbeatAt?.toISOString() ?? null,
        workers: {
          total: summary.total,
          healthy: summary.healthy,
          degraded: summary.degraded,
          delayed: summary.delayed,
          unknown: summary.unknown,
          oldestHeartbeatAt: summary.oldestHeartbeatAt?.toISOString() ?? null,
          freshestHeartbeatAt: summary.freshestHeartbeatAt?.toISOString() ?? null,
        },
      },
      { status: ok ? 200 : 503 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, database: "failed", error: message },
      { status: 503 },
    );
  }
}
