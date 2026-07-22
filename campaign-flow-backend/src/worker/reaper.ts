import { env } from "../config/env.js";
import { pool } from "../db/client.js";
import { sendQueue } from "../queue/queues.js";

/**
 * Reaper — recovers rows a crashed worker left stuck in 'sending'. Rows claimed
 * longer than CLAIM_TIMEOUT_MS go back to 'pending' (or 'failed' once attempts are
 * exhausted) and their range is re-enqueued so they actually get retried.
 *
 * Caveat: if the worker DID send before crashing, resetting to pending risks a
 * duplicate — this system is at-least-once, not exactly-once (documented).
 */
let timer: NodeJS.Timeout | null = null;

export function startReaper(): void {
  timer = setInterval(() => void tick(), env.REAPER_TICK_MS);
  console.log(`[reaper] started: claimTimeout=${env.CLAIM_TIMEOUT_MS}ms`);
}

async function tick(): Promise<void> {
  try {
    // Exhausted -> DLQ (failed).
    await pool.query(
      `UPDATE recipients
          SET send_status = 'failed', last_error = 'reaped_after_max_attempts',
              claimed_at = NULL, updated_at = now()
        WHERE send_status = 'sending'
          AND claimed_at < now() - ($1::int || ' milliseconds')::interval
          AND attempts >= $2`,
      [env.CLAIM_TIMEOUT_MS, env.MAX_ATTEMPTS],
    );

    // Recoverable -> back to pending, grouped by campaign for re-enqueue.
    const { rows } = await pool.query<{ campaign_id: string; lo: string; hi: string }>(
      `WITH reaped AS (
         UPDATE recipients
            SET send_status = 'pending', claimed_at = NULL, updated_at = now()
          WHERE send_status = 'sending'
            AND claimed_at < now() - ($1::int || ' milliseconds')::interval
            AND attempts < $2
          RETURNING campaign_id, id
       )
       SELECT campaign_id, min(id) AS lo, max(id) AS hi FROM reaped GROUP BY campaign_id`,
      [env.CLAIM_TIMEOUT_MS, env.MAX_ATTEMPTS],
    );

    for (const r of rows) {
      await sendQueue.add(
        "send",
        { campaignId: r.campaign_id, fromId: Number(r.lo), toId: Number(r.hi) },
        { jobId: `reap-${r.campaign_id}-${r.lo}-${Date.now()}` },
      );
      console.log(`[reaper] recovered campaign ${r.campaign_id} range ${r.lo}-${r.hi}`);
    }
  } catch (err) {
    console.error("[reaper] tick error", err);
  }
}

export function stopReaper(): void {
  if (timer) clearInterval(timer);
}
