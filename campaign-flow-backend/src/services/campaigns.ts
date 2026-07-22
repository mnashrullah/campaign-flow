import { eq } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { campaigns, campaignStats, type Campaign } from "../db/schema.js";
import { producerQueue } from "../queue/queues.js";
import { setCounters, type CounterField } from "../lib/counters.js";

export interface CreateCampaignInput {
  name: string;
  subject: string;
  bodyTemplate: string;
  fromEmail: string;
  provider: string;
}

export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const [row] = await db.insert(campaigns).values(input).returning();
  await db.insert(campaignStats).values({ campaignId: row.id }).onConflictDoNothing();
  return row;
}

export async function getCampaign(id: string): Promise<Campaign | undefined> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  return row;
}

export async function listCampaigns(): Promise<Campaign[]> {
  return db.select().from(campaigns).orderBy(campaigns.createdAt);
}

export async function setStatus(id: string, status: Campaign["status"]): Promise<void> {
  const patch: Partial<Campaign> = { status };
  if (status === "running") patch.startedAt = new Date();
  if (status === "send_complete" || status === "settled") patch.completedAt = new Date();
  await db.update(campaigns).set(patch).where(eq(campaigns.id, id));
}

/** Start (or resume) sending: mark running and fan out via the producer. */
export async function startCampaign(id: string): Promise<void> {
  await setStatus(id, "running");
  await producerQueue.add("fanout", { campaignId: id }, { jobId: `producer-${id}-${Date.now()}` });
}

export async function pauseCampaign(id: string): Promise<void> {
  await setStatus(id, "paused");
}

export async function cancelCampaign(id: string): Promise<void> {
  await setStatus(id, "cancelled");
}

export async function isActive(id: string): Promise<boolean> {
  const c = await getCampaign(id);
  return c?.status === "running";
}

/**
 * Requeue the dead-letter: reset recipients that failed after exhausting retries
 * back to pending (fresh attempt budget) and re-run the producer. Returns how many
 * were requeued.
 */
export async function retryDlq(id: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE recipients
        SET send_status = 'pending', attempts = 0, last_error = NULL,
            claimed_at = NULL, updated_at = now()
      WHERE campaign_id = $1 AND send_status = 'failed'
        AND last_error IN ('retries_exhausted','reaped_after_max_attempts')`,
    [id],
  );
  if (rowCount && rowCount > 0) {
    await setStatus(id, "running");
    await producerQueue.add("fanout", { campaignId: id }, { jobId: `producer-${id}-retry-${Date.now()}` });
  }
  return rowCount ?? 0;
}

/**
 * Authoritative counts straight from the recipient rows. This is the source of
 * truth the reconciler flushes into Redis + campaign_stats.
 */
export async function computeStatsFromDb(id: string): Promise<Record<CounterField, number>> {
  const out: Record<CounterField, number> = {
    pending: 0, sending: 0, sent: 0, failed: 0, suppressed: 0,
    delivered: 0, bounced: 0, complained: 0, retried: 0, dlq: 0,
  };
  const send = await pool.query(
    `SELECT send_status AS k, count(*)::bigint AS n
       FROM recipients WHERE campaign_id = $1 GROUP BY send_status`,
    [id],
  );
  for (const r of send.rows) out[r.k as CounterField] = Number(r.n);
  const del = await pool.query(
    `SELECT delivery_status AS k, count(*)::bigint AS n
       FROM recipients WHERE campaign_id = $1 AND delivery_status <> 'unknown'
       GROUP BY delivery_status`,
    [id],
  );
  for (const r of del.rows) out[r.k as CounterField] = Number(r.n);
  // retried = recipients attempted more than once; dlq = failed after exhausting retries.
  const extra = await pool.query(
    `SELECT
        count(*) FILTER (WHERE attempts > 1)::bigint AS retried,
        count(*) FILTER (WHERE send_status = 'failed'
                          AND last_error IN ('retries_exhausted','reaped_after_max_attempts'))::bigint AS dlq
       FROM recipients WHERE campaign_id = $1`,
    [id],
  );
  out.retried = Number(extra.rows[0].retried);
  out.dlq = Number(extra.rows[0].dlq);
  return out;
}

/** Flush authoritative counts into campaign_stats + Redis (reconcile drift). */
export async function reconcile(id: string): Promise<Record<CounterField, number>> {
  const s = await computeStatsFromDb(id);
  await db
    .update(campaignStats)
    .set({ ...s, updatedAt: new Date() })
    .where(eq(campaignStats.campaignId, id));
  await setCounters(id, s);
  return s;
}

/** Move running -> send_complete once nothing is left to send. */
export async function maybeComplete(id: string): Promise<boolean> {
  const c = await getCampaign(id);
  if (!c || c.status !== "running") return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM recipients
      WHERE campaign_id = $1 AND send_status IN ('pending','sending') LIMIT 1`,
    [id],
  );
  if (rows.length === 0) {
    await setStatus(id, "send_complete");
    return true;
  }
  return false;
}
