import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env } from "../config/env.js";
import { EmailProvider, RenderedEmail, SendResult, ThrottleError } from "./types.js";

// SES error names that mean "don't retry this recipient".
const PERMANENT_ERRORS = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
]);
const THROTTLE_ERRORS = new Set(["ThrottlingException", "TooManyRequestsException"]);

/**
 * Amazon SES (v2). Personalized HTML is sent per-recipient via SendEmail with
 * bounded concurrency (maxBatchSize) rather than SES templates, so each message
 * keeps its own rendered body. The one-click List-Unsubscribe header requires Raw
 * MIME — see README; here the unsubscribe link lives in the body.
 */
export class SesProvider implements EmailProvider {
  readonly name = "ses";
  readonly maxBatchSize = env.SES_MAX_BATCH;
  readonly ratePerSec = env.SES_RATE_PER_SEC;
  private client = new SESv2Client({ region: env.SES_REGION });

  async sendBatch(messages: RenderedEmail[]): Promise<SendResult[]> {
    const settled = await Promise.allSettled(messages.map((m) => this.sendOne(m)));

    const results: SendResult[] = [];
    let throttled = 0;
    let ok = 0;

    settled.forEach((s, i) => {
      const m = messages[i];
      if (s.status === "fulfilled") {
        ok++;
        results.push({
          recipientId: m.recipientId,
          status: "sent",
          permanent: false,
          providerMessageId: s.value,
        });
        return;
      }
      const name: string = s.reason?.name ?? "UnknownError";
      const isThrottle = THROTTLE_ERRORS.has(name);
      if (isThrottle) throttled++;
      results.push({
        recipientId: m.recipientId,
        status: "failed",
        permanent: PERMANENT_ERRORS.has(name),
        error: name,
      });
    });

    // Nothing got through and we saw throttling -> signal AIMD to back off and let
    // the worker retry the whole chunk. Mixed batches return per-recipient results
    // instead, to avoid re-sending the ones that already succeeded.
    if (ok === 0 && throttled > 0) throw new ThrottleError("ses throttled");
    return results;
  }

  private async sendOne(m: RenderedEmail): Promise<string> {
    const res = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: m.from,
        Destination: { ToAddresses: [m.to] },
        Content: {
          Simple: {
            Subject: { Data: m.subject, Charset: "UTF-8" },
            Body: { Html: { Data: m.html, Charset: "UTF-8" } },
          },
        },
        ConfigurationSetName: env.SES_CONFIGURATION_SET,
      }),
    );
    return res.MessageId ?? `ses-${m.idempotencyKey}`;
  }
}
