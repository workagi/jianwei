import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { runtimeHealth } from "@/db/schema";
import { eq } from "drizzle-orm";
import { deriveWorkerHealth } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    const [heartbeat] = await db
      .select({ status: runtimeHealth.status, lastHeartbeatAt: runtimeHealth.lastHeartbeatAt })
      .from(runtimeHealth)
      .where(eq(runtimeHealth.service, "worker"))
      .limit(1);
    const lastHeartbeatAt = heartbeat?.lastHeartbeatAt ?? null;
    const worker = deriveWorkerHealth({
      status: heartbeat?.status,
      lastHeartbeatAt,
      staleAfterSeconds: Number(process.env.WORKER_HEALTHCHECK_STALE_SECONDS) || 300,
    });
    return NextResponse.json({
      ok: worker === "ok",
      database: "ok",
      worker,
      workerLastHeartbeatAt: lastHeartbeatAt?.toISOString() ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, database: "failed", error: message },
      { status: 503 },
    );
  }
}
