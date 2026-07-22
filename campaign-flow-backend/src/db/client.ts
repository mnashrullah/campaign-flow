import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

/**
 * A single shared pool. Worker concurrency (WORKER_CONCURRENCY) plus the API must
 * not exceed `max`, or we exhaust Postgres connections under load — so the pool is
 * sized with headroom above the worker count.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: Math.max(env.WORKER_CONCURRENCY + 8, 16),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  console.error("[db] unexpected pool error", err);
});

export const db = drizzle(pool, { schema });
export { schema };
