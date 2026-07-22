import { Resend } from "resend";
import { env } from "../config/env.js";
import { EmailProvider, RenderedEmail, SendResult, ThrottleError } from "./types.js";

/**
 * Resend. Uses the batch endpoint (up to 100/call). A 429 throttles the whole
 * batch -> ThrottleError -> AIMD backs off and the chunk is retried.
 */
export class ResendProvider implements EmailProvider {
  readonly name = "resend";
  readonly maxBatchSize = env.RESEND_MAX_BATCH;
  readonly ratePerSec = env.RESEND_RATE_PER_SEC;
  private client: Resend;

  constructor() {
    if (!env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required when PROVIDER=resend");
    }
    this.client = new Resend(env.RESEND_API_KEY);
  }

  async sendBatch(messages: RenderedEmail[]): Promise<SendResult[]> {
    const { data, error } = await this.client.batch.send(
      messages.map((m) => ({
        from: m.from,
        to: [m.to],
        subject: m.subject,
        html: m.html,
        headers: {
          // RFC 8058 one-click unsubscribe — required by Gmail/Yahoo bulk rules.
          "List-Unsubscribe": `<${m.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      })),
    );

    if (error) {
      const name = (error as { name?: string }).name ?? "";
      if (name.includes("rate_limit") || name.includes("429")) {
        throw new ThrottleError("resend rate limited");
      }
      // Whole-batch error, not throttling: fail every recipient transiently so the
      // chunk retries (could be a transient upstream error).
      return messages.map((m) => ({
        recipientId: m.recipientId,
        status: "failed" as const,
        permanent: false,
        error: name || "resend batch error",
      }));
    }

    const ids = data?.data ?? [];
    return messages.map((m, i) => ({
      recipientId: m.recipientId,
      status: "sent" as const,
      permanent: false,
      providerMessageId: ids[i]?.id ?? `resend-${m.idempotencyKey}`,
    }));
  }
}
