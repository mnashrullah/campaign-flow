import { pool } from "../db/client.js";
import { env } from "../config/env.js";
import { reconcile } from "./campaigns.js";

/**
 * Generate N synthetic recipients for a campaign, entirely server-side via
 * generate_series (no buffering in Node). A DRYRUN_INVALID_RATE slice is
 * deliberately malformed to exercise the validation path.
 */
export async function generateRecipients(
  campaignId: string,
  count: number,
  onProgress?: (done: number) => void,
): Promise<void> {
  const CHUNK = 100_000;
  for (let from = 1; from <= count; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, count);
    await pool.query(
      `INSERT INTO recipients (campaign_id, email, name, idempotency_key)
       SELECT $1,
              CASE WHEN random() < $2
                   THEN 'invalid-address-' || g
                   ELSE 'user' || g || '@example.com' END,
              'User ' || g,
              'r' || g
       FROM generate_series($3::bigint, $4::bigint) AS g
       ON CONFLICT (campaign_id, idempotency_key) DO NOTHING`,
      [campaignId, env.DRYRUN_INVALID_RATE, from, to],
    );
    onProgress?.(to);
  }
  await pool.query(`UPDATE campaigns SET total_recipients = $2 WHERE id = $1`, [campaignId, count]);
  await reconcile(campaignId);
}
