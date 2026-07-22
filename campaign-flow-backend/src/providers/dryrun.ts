import { env } from "../config/env.js";
import { sleep, roll } from "../lib/util.js";
import { webhookQueue } from "../queue/queues.js";
import { EmailProvider, RenderedEmail, SendResult, ThrottleError } from "./types.js";

/**
 * Simulated provider. Sends nothing, but reproduces every real-world code path so
 * the full pipeline (retries, DLQ, AIMD back-off, async bounces, circuit-breaker)
 * can be demonstrated on 1,000,000 recipients without touching a real inbox.
 *
 * All behaviour is driven by DRYRUN_* env knobs, so it is fully configurable —
 * fast for a demo, or slow + failure-heavy to stress the control loops.
 */
export class DryRunProvider implements EmailProvider {
  readonly name = "dryrun";
  readonly maxBatchSize = env.DRYRUN_MAX_BATCH;
  readonly ratePerSec = env.DRYRUN_RATE_PER_SEC;

  async sendBatch(messages: RenderedEmail[]): Promise<SendResult[]> {
    // Simulated network/API latency for the whole batch.
    if (env.DRYRUN_LATENCY_MS > 0) await sleep(env.DRYRUN_LATENCY_MS);

    // Whole-batch throttling (HTTP 429). Worker reports this to AIMD and retries.
    if (roll(env.DRYRUN_THROTTLE_RATE)) {
      throw new ThrottleError("dryrun simulated throttle");
    }

    const results: SendResult[] = [];
    for (const m of messages) {
      // Transient error (5xx) -> retried by the worker.
      if (roll(env.DRYRUN_TRANSIENT_ERROR_RATE)) {
        results.push({
          recipientId: m.recipientId,
          status: "failed",
          permanent: false,
          error: "dryrun simulated transient error",
        });
        continue;
      }
      // Hard rejection at send time -> permanent failure, no retry.
      if (roll(env.DRYRUN_HARD_FAIL_RATE)) {
        results.push({
          recipientId: m.recipientId,
          status: "failed",
          permanent: true,
          error: "dryrun simulated hard failure",
        });
        continue;
      }

      // Accepted. Globally-unique, stable id derived from the recipient's PK so a
      // retried send maps to the same "provider message" (mirrors provider-side
      // dedupe) without colliding across campaigns.
      const providerMessageId = `dr-${m.recipientId}`;
      results.push({ recipientId: m.recipientId, status: "sent", permanent: false, providerMessageId });

      // Schedule asynchronous delivery feedback, exactly like a real provider's
      // webhooks arriving seconds later. Delay covers the worker's own DB commit.
      this.scheduleAsyncFeedback(providerMessageId, m.to);
    }
    return results;
  }

  private scheduleAsyncFeedback(providerMessageId: string, email: string) {
    const delay = 500 + Math.floor(Math.random() * 3000);
    let type: "delivered" | "bounce" | "complaint" = "delivered";
    if (roll(env.DRYRUN_BOUNCE_RATE)) type = "bounce";
    else if (roll(env.DRYRUN_COMPLAINT_RATE)) type = "complaint";

    // Fire-and-forget; failure to enqueue simulated feedback must not fail the send.
    void webhookQueue.add(
      "feedback",
      {
        campaignId: "", // resolved from providerMessageId at ingest time
        providerMessageId,
        type,
        providerEventId: `${providerMessageId}:${type}`,
        email,
      },
      { delay },
    );
  }
}
