import { Worker } from "bullmq";
import { createRedis } from "../queue/connection.js";
import { pool } from "../db/client.js";
import { env } from "../config/env.js";
import { QUEUE_PRODUCER, sendQueue, type ProducerJob, type SendChunkJob } from "../queue/queues.js";
import { maybeComplete } from "../services/campaigns.js";

/**
 * Fans a campaign into chunk jobs over id-ranges of *pending* recipients. Uses
 * min/max(id) + fixed strides, so 1M recipients become ~2,000 lightweight jobs and
 * the producer never holds rows in memory. Idempotent by jobId, so re-running it
 * (e.g. on resume) never double-enqueues an in-flight chunk.
 */
export function startProducer(): Worker<ProducerJob> {
  const worker = new Worker<ProducerJob>(
    QUEUE_PRODUCER,
    async (job) => {
      const { campaignId } = job.data;
      const { rows } = await pool.query<{ min: string | null; max: string | null }>(
        `SELECT min(id) AS min, max(id) AS max
           FROM recipients
          WHERE campaign_id = $1 AND send_status IN ('pending','sending')`,
        [campaignId],
      );
      const min = rows[0].min ? Number(rows[0].min) : null;
      const max = rows[0].max ? Number(rows[0].max) : null;

      if (min == null || max == null) {
        await maybeComplete(campaignId);
        return { chunks: 0 };
      }

      const size = env.CHUNK_SIZE;
      const jobs: { name: string; data: SendChunkJob; opts: { jobId: string } }[] = [];
      for (let from = min; from <= max; from += size) {
        const to = Math.min(from + size - 1, max);
        jobs.push({
          name: "send",
          data: { campaignId, fromId: from, toId: to },
          opts: { jobId: `send-${campaignId}-${from}` },
        });
      }

      // addBulk in batches to avoid one gigantic pipeline.
      const BULK = 1000;
      for (let i = 0; i < jobs.length; i += BULK) {
        await sendQueue.addBulk(jobs.slice(i, i + BULK));
      }
      console.log(`[producer] campaign ${campaignId}: enqueued ${jobs.length} chunks`);
      return { chunks: jobs.length };
    },
    { connection: createRedis(), concurrency: 1 },
  );

  worker.on("failed", (job, err) => console.error(`[producer] job ${job?.id} failed`, err));
  return worker;
}
