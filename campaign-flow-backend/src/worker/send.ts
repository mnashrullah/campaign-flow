import { Worker } from "bullmq";
import type { PoolClient } from "pg";
import { createRedis } from "../queue/connection.js";
import { pool } from "../db/client.js";
import { env } from "../config/env.js";
import { QUEUE_SEND, sendQueue, type SendChunkJob } from "../queue/queues.js";
import { getProvider, ThrottleError, type RenderedEmail } from "../providers/index.js";
import { getCurrentRate, signalThrottle, KEY_BUCKET } from "../ratelimit/rateState.js";
import { takeTokens } from "../ratelimit/tokenBucket.js";
import { bumpCounters } from "../lib/counters.js";
import { isValidEmail, renderTemplate, unsubscribeUrl } from "../lib/email.js";
import { sleep, chunk } from "../lib/util.js";
import { getCampaign, maybeComplete } from "../services/campaigns.js";

interface ClaimedRow {
  id: number;
  email: string;
  name: string;
  idempotency_key: string;
  attempts: number;
}

/**
 * Send worker — the workhorse. One job = one chunk (id-range). Steps:
 *   1. bail if the campaign isn't running (pause/cancel stops sending)
 *   2. atomically CLAIM pending rows -> 'sending' (idempotent; no double-send)
 *   3. validate + suppression-filter
 *   4. render (HTML-escaped) and send through the provider in rate-gated batches
 *   5. persist every outcome + terminal counters in ONE transaction
 *   6. re-enqueue retryable rows (per-recipient attempts), DLQ the exhausted ones
 */
export function startSendWorker(): Worker<SendChunkJob> {
  const worker = new Worker<SendChunkJob>(
    QUEUE_SEND,
    async (job) => {
      const { campaignId, fromId, toId } = job.data;

      const campaign = await getCampaign(campaignId);
      if (!campaign || campaign.status !== "running") return { skipped: true };

      // Provider is chosen per-campaign (dry-run vs live), cached per name.
      const provider = getProvider(campaign.provider);

      // 1. Claim — pending -> sending, atomically, incrementing attempts.
      const claimed = await claim(campaignId, fromId, toId);
      if (claimed.length === 0) {
        await maybeComplete(campaignId);
        return { claimed: 0 };
      }

      // 2. Validate + suppression.
      const suppressed = await suppressedSet(claimed.map((r) => r.email));
      const invalidIds: number[] = [];
      const suppressedIds: number[] = [];
      const toSend: ClaimedRow[] = [];
      for (const r of claimed) {
        if (!isValidEmail(r.email)) invalidIds.push(r.id);
        else if (suppressed.has(r.email)) suppressedIds.push(r.id);
        else toSend.push(r);
      }

      // 3. Send in provider-sized, rate-gated batches.
      const sent: { id: number; pmid: string }[] = [];
      const permFail: { id: number; error: string }[] = [];
      const transient: { id: number; error: string }[] = [];
      const throttledIds: number[] = [];
      let throttled = false;

      for (const batch of chunk(toSend, provider.maxBatchSize)) {
        if (throttled) {
          for (const r of batch) throttledIds.push(r.id);
          continue;
        }
        await rateGate(batch.length);
        const rendered = batch.map((r) => render(campaign, r));
        try {
          const results = await provider.sendBatch(rendered);
          for (const res of results) {
            if (res.status === "sent") sent.push({ id: res.recipientId, pmid: res.providerMessageId! });
            else if (res.permanent) permFail.push({ id: res.recipientId, error: res.error ?? "permanent" });
            else transient.push({ id: res.recipientId, error: res.error ?? "transient" });
          }
        } catch (err) {
          if (err instanceof ThrottleError) {
            await signalThrottle();
            throttled = true;
            for (const r of batch) throttledIds.push(r.id);
          } else {
            for (const r of batch) transient.push({ id: r.id, error: (err as Error).message });
          }
        }
      }

      // 4. Split transient into retry vs give-up (DLQ) by per-recipient attempts.
      const attemptsById = new Map(claimed.map((r) => [r.id, r.attempts]));
      const retryIds: number[] = [];
      const giveUp: { id: number; error: string }[] = [];
      for (const t of transient) {
        if ((attemptsById.get(t.id) ?? env.MAX_ATTEMPTS) >= env.MAX_ATTEMPTS) giveUp.push(t);
        else retryIds.push(t.id);
      }

      // 5. Persist everything atomically.
      await persist(campaignId, { sent, invalidIds, suppressedIds, permFail, giveUp, retryIds, throttledIds });

      // 6. Live counters (terminal states) — reconciler will refresh pending/sending.
      await bumpCounters(campaignId, {
        sent: sent.length,
        suppressed: suppressedIds.length,
        failed: invalidIds.length + permFail.length + giveUp.length,
        retried: retryIds.length,
        dlq: giveUp.length,
      });

      // 7. Re-enqueue retryable rows (transient retries + throttled) as a continuation.
      const requeue = [...retryIds, ...throttledIds];
      if (requeue.length > 0) {
        const lo = Math.min(...requeue);
        const hi = Math.max(...requeue);
        await sendQueue.add(
          "send",
          { campaignId, fromId: lo, toId: hi },
          { jobId: `send-${campaignId}-${lo}-r${Date.now()}`, delay: throttled ? 1500 : 500 },
        );
      }

      await maybeComplete(campaignId);
      return { claimed: claimed.length, sent: sent.length, throttled };
    },
    { connection: createRedis(), concurrency: env.WORKER_CONCURRENCY },
  );

  worker.on("failed", (job, err) => console.error(`[send] job ${job?.id} failed (DLQ)`, err.message));
  return worker;
}

// ---- helpers ---------------------------------------------------------------

async function claim(campaignId: string, fromId: number, toId: number): Promise<ClaimedRow[]> {
  const { rows } = await pool.query<ClaimedRow>(
    `UPDATE recipients
        SET send_status = 'sending', claimed_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM recipients
         WHERE campaign_id = $1 AND id BETWEEN $2 AND $3 AND send_status = 'pending'
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, email, name, idempotency_key, attempts`,
    [campaignId, fromId, toId],
  );
  return rows;
}

async function suppressedSet(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const { rows } = await pool.query<{ email: string }>(
    `SELECT email FROM suppression WHERE email = ANY($1::text[])`,
    [emails],
  );
  return new Set(rows.map((r) => r.email));
}

function render(
  campaign: NonNullable<Awaited<ReturnType<typeof getCampaign>>>,
  r: ClaimedRow,
): RenderedEmail {
  const unsub = unsubscribeUrl(campaign.id, r.email);
  const vars = { name: r.name, email: r.email, unsubscribeUrl: unsub };
  return {
    recipientId: r.id,
    from: campaign.fromEmail,
    to: r.email,
    name: r.name,
    subject: renderTemplate(campaign.subject, vars),
    html: renderTemplate(campaign.bodyTemplate, vars),
    idempotencyKey: r.idempotency_key,
    unsubscribeUrl: unsub,
  };
}

interface PersistGroups {
  sent: { id: number; pmid: string }[];
  invalidIds: number[];
  suppressedIds: number[];
  permFail: { id: number; error: string }[];
  giveUp: { id: number; error: string }[];
  retryIds: number[];
  throttledIds: number[];
}

async function persist(campaignId: string, g: PersistGroups): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (g.sent.length) {
      await client.query(
        `UPDATE recipients AS r
            SET send_status = 'sent', provider_message_id = d.pmid,
                claimed_at = NULL, last_error = NULL, updated_at = now()
           FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS pmid) d
          WHERE r.id = d.id`,
        [g.sent.map((s) => s.id), g.sent.map((s) => s.pmid)],
      );
    }
    if (g.invalidIds.length) {
      await failRows(client, g.invalidIds, "invalid_email");
    }
    if (g.suppressedIds.length) {
      await client.query(
        `UPDATE recipients SET send_status = 'suppressed', claimed_at = NULL, updated_at = now()
          WHERE id = ANY($1::bigint[])`,
        [g.suppressedIds],
      );
    }
    if (g.permFail.length) {
      await failRows(client, g.permFail.map((p) => p.id), "permanent_failure");
    }
    if (g.giveUp.length) {
      await failRows(client, g.giveUp.map((p) => p.id), "retries_exhausted");
    }
    // Retryable + throttled go back to pending; throttled shouldn't burn an attempt.
    if (g.retryIds.length) {
      await client.query(
        `UPDATE recipients SET send_status = 'pending', claimed_at = NULL, updated_at = now()
          WHERE id = ANY($1::bigint[])`,
        [g.retryIds],
      );
    }
    if (g.throttledIds.length) {
      await client.query(
        `UPDATE recipients
            SET send_status = 'pending', claimed_at = NULL,
                attempts = GREATEST(attempts - 1, 0), updated_at = now()
          WHERE id = ANY($1::bigint[])`,
        [g.throttledIds],
      );
    }

    // Terminal counters (monotonic) — consistent with the row updates above.
    const failed = g.invalidIds.length + g.permFail.length + g.giveUp.length;
    await client.query(
      `UPDATE campaign_stats
          SET sent = sent + $2, failed = failed + $3, suppressed = suppressed + $4, updated_at = now()
        WHERE campaign_id = $1`,
      [campaignId, g.sent.length, failed, g.suppressedIds.length],
    );

    // Failure audit events (bounded — failures are a minority; we skip per-sent events).
    const failEvents = [
      ...g.invalidIds.map((id) => ({ id, type: "fail", reason: "invalid_email" })),
      ...g.permFail.map((p) => ({ id: p.id, type: "fail", reason: p.error })),
      ...g.giveUp.map((p) => ({ id: p.id, type: "fail", reason: "retries_exhausted" })),
    ];
    if (failEvents.length) {
      await client.query(
        `INSERT INTO events (campaign_id, recipient_id, type, payload)
         SELECT $1, d.id, d.type, jsonb_build_object('reason', d.reason)
           FROM (SELECT unnest($2::bigint[]) AS id, unnest($3::text[]) AS type,
                        unnest($4::text[]) AS reason) d`,
        [
          campaignId,
          failEvents.map((e) => e.id),
          failEvents.map((e) => e.type),
          failEvents.map((e) => e.reason),
        ],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function failRows(client: PoolClient, ids: number[], reason: string) {
  return client.query(
    `UPDATE recipients SET send_status = 'failed', last_error = $2, claimed_at = NULL, updated_at = now()
      WHERE id = ANY($1::bigint[])`,
    [ids, reason],
  );
}

// ---- rate gate -------------------------------------------------------------

/** Block until `n` tokens are available from the global bucket at the live rate. */
async function rateGate(n: number): Promise<void> {
  for (;;) {
    const rate = await getCurrentRate();
    const { allowed, waitMs } = await takeTokens(KEY_BUCKET, rate, n);
    if (allowed) return;
    await sleep(Math.min(waitMs || 50, 250)); // cap so a rate change is picked up quickly
  }
}
