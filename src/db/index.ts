import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://monitor:monitor@localhost:54329/monitor";

// Reuse a single postgres-js pool across Next.js hot reloads in development so
// we don't leak connections on every change.
const globalForDb = globalThis as unknown as {
  __signaldeckSql?: ReturnType<typeof postgres>;
};

const client = globalForDb.__signaldeckSql ?? postgres(connectionString, {
  max: Math.max(1, Number(process.env.DATABASE_POOL_MAX) || 4),
  // Short reader queries must not spend more time compiling JIT than executing SQL.
  connection: { jit: "off" },
});
if (process.env.NODE_ENV !== "production") globalForDb.__signaldeckSql = client;

export const sql = client;
export const db = drizzle(client, { schema });
