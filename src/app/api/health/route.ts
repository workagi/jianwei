import { NextResponse } from "next/server";
import { sql, like, desc } from "drizzle-orm";
import { db } from "@/db";
import { runtimeHealth } from "@/db/schema";
import { deriveWorkerHealth } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    const [heartbeat] = await db
      .select({ status: runtimeHealth.status, lastHeartbeatAt: runtimeHealth.lastHeartbeatAt })
      .from(runtimeHealth)
      .where(like(runtimeHealth.service, "worker:%"))
      .orderBy(desc(runtimeHealth.lastHeartbeatAt))
      .limit(1);
    const lastHeartbeatAt = heartbeat?.lastHeartbeatAt ?? null;
    const worker = deriveWorkerHealth({
      status: heartbeat?.status,
      lastHeartbeatAt,
      staleAfterSeconds: Number(process.env.WORKER_HEALTHCHECK_STALE_SECONDS) || 300,
    });
    const ok = worker === "ok";
    return NextResponse.json(
      {
        ok,
        database: "ok",
        worker,
        workerLastHeartbeatAt: lastHeartbeatAt?.toISOString() ?? null,
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
