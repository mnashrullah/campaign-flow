import { Queue } from "bullmq";
import { createRedis } from "./connection.js";
import { env } from "../config/env.js";

export const QUEUE_SEND = "send-chunk";
export const QUEUE_PRODUCER = "producer";
export const QUEUE_WEBHOOK = "webhook-ingest";

export interface ProducerJob {
  campaignId: string;
}

export interface SendChunkJob {
  campaignId: string;
  // Recipients are claimed by id-range so the producer never loads rows into memory.
  fromId: number;
  toId: number;
}

// Normalised provider callback. Real SES(SNS)/Resend webhooks are mapped into this
// shape by the HTTP handler; the dry-run provider enqueues these directly to
// simulate asynchronous delivery feedback.
export interface WebhookJob {
  campaignId: string;
  providerMessageId: string;
  type: "delivered" | "bounce" | "complaint";
  providerEventId: string; // dedupe key (at-least-once delivery)
  email?: string;
}

const connection = createRedis();

/** Fans a campaign into chunk jobs. One job, runs once per start. */
export const producerQueue = new Queue<ProducerJob>(QUEUE_PRODUCER, {
  connection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 500,
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  },
});

/**
 * The send workhorse. attempts = MAX_ATTEMPTS: transient failures retry with
 * exponential backoff; once exhausted the job lands in the failed set (our DLQ).
 */
export const sendQueue = new Queue<SendChunkJob>(QUEUE_SEND, {
  connection,
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: false, // keep failed jobs — this set IS the dead-letter queue
    attempts: env.MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: 3000 },
  },
});

/** Async delivery feedback (delivered/bounce/complaint). Idempotent by design. */
export const webhookQueue = new Queue<WebhookJob>(QUEUE_WEBHOOK, {
  connection,
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 500,
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
  },
});
