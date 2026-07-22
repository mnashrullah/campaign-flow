import { Worker } from "bullmq";
import { createRedis } from "../queue/connection.js";
import { pool } from "../db/client.js";
import { QUEUE_WEBHOOK, type WebhookJob } from "../queue/queues.js";
import { bumpCounters, type CounterField } from "../lib/counters.js";

/**
 * Async delivery-feedback ingest (delivered/bounce/complaint). Handles the two
 * real hazards of provider webhooks:
 *   - out-of-order: a delivery event can arrive before our own 'sent' commit, so
 *     we resolve the recipient by provider_message_id and RETRY if not found yet.
 *   - at-least-once: duplicate events are de-duped by provider_event_id, so a
 *     replay is a no-op and never double-counts.
 * Delivery status transitions are monotonic (a 'bounced' is never downgraded).
 */
export function startWebhookWorker(): Worker<WebhookJob> {
  const worker = new Worker<WebhookJob>(
    QUEUE_WEBHOOK,
    async (job) => {
      const { providerMessageId, type, providerEventId } = job.data;

      const rcpt = await pool.query<{ id: number; campaign_id: string; email: string }>(
        `SELECT id, campaign_id, email FROM recipients WHERE provider_message_id = $1 LIMIT 1`,
        [providerMessageId],
      );
      if (rcpt.rows.length === 0) {
        // 'sent' not committed yet (or unknown id) — throw to retry with backoff.
        throw new Error(`recipient not found for ${providerMessageId}`);
      }
      const { id: recipientId, campaign_id: campaignId, email } = rcpt.rows[0];

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Idempotent ingest: duplicate provider_event_id -> no rows -> stop.
        const ins = await client.query(
          `INSERT INTO events (campaign_id, recipient_id, type, provider_event_id, payload)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (provider_event_id) DO NOTHING
           RETURNING id`,
          [campaignId, recipientId, type, providerEventId, JSON.stringify({ email })],
        );
        if (ins.rowCount === 0) {
          await client.query("COMMIT");
          return { duplicate: true };
        }

        let changed = 0;
        let counter: CounterField | null = null;
        if (type === "delivered") {
          const r = await client.query(
            `UPDATE recipients SET delivery_status = 'delivered', updated_at = now()
              WHERE id = $1 AND delivery_status = 'unknown'`,
            [recipientId],
          );
          changed = r.rowCount ?? 0;
          counter = "delivered";
        } else if (type === "bounce") {
          const r = await client.query(
            `UPDATE recipients SET delivery_status = 'bounced', updated_at = now()
              WHERE id = $1 AND delivery_status <> 'complained'`,
            [recipientId],
          );
          changed = r.rowCount ?? 0;
          counter = "bounced";
          await client.query(
            `INSERT INTO suppression (email, reason) VALUES ($1, 'bounce') ON CONFLICT DO NOTHING`,
            [email],
          );
        } else if (type === "complaint") {
          const r = await client.query(
            `UPDATE recipients SET delivery_status = 'complained', updated_at = now() WHERE id = $1`,
            [recipientId],
          );
          changed = r.rowCount ?? 0;
          counter = "complained";
          await client.query(
            `INSERT INTO suppression (email, reason) VALUES ($1, 'complaint') ON CONFLICT DO NOTHING`,
            [email],
          );
        }

        if (changed > 0 && counter) {
          await client.query(
            `UPDATE campaign_stats SET ${counter} = ${counter} + 1, updated_at = now()
              WHERE campaign_id = $1`,
            [campaignId],
          );
        }

        await client.query("COMMIT");

        if (changed > 0 && counter) await bumpCounters(campaignId, { [counter]: 1 });
        return { type, changed };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    { connection: createRedis(), concurrency: 8 },
  );

  worker.on("failed", (job, err) =>
    console.error(`[webhook] job ${job?.id} failed`, err.message),
  );
  return worker;
}
