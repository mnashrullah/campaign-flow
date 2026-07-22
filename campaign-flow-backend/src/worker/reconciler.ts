import { env } from "../config/env.js";
import { pool } from "../db/client.js";
import { reconcile, maybeComplete } from "../services/campaigns.js";

/**
 * Reconciler — the drift/self-heal loop. For every active campaign it recomputes
 * authoritative counts from the recipient rows and overwrites campaign_stats +
 * Redis. This corrects any counter drift (a lost Redis increment on crash) and
 * keeps pending/sending accurate for the UI. Also finalises completed campaigns.
 */
let timer: NodeJS.Timeout | null = null;

export function startReconciler(): void {
  timer = setInterval(() => void tick(), env.RECONCILER_TICK_MS);
  console.log(`[reconciler] started: every ${env.RECONCILER_TICK_MS}ms`);
}

async function tick(): Promise<void> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM campaigns WHERE status IN ('running','paused','send_complete')`,
    );
    for (const r of rows) {
      await reconcile(r.id);
      await maybeComplete(r.id);
    }
  } catch (err) {
    console.error("[reconciler] tick error", err);
  }
}

export function stopReconciler(): void {
  if (timer) clearInterval(timer);
}
