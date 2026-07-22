/** One fully-rendered, personalized message ready to hand to a provider. */
export interface RenderedEmail {
  recipientId: number;
  from: string;
  to: string;
  name: string;
  subject: string;
  html: string;
  idempotencyKey: string;
  unsubscribeUrl: string;
}

/** Per-recipient outcome of a send attempt. */
export interface SendResult {
  recipientId: number;
  status: "sent" | "failed";
  /** For failures: true = don't retry (hard bounce / invalid), false = transient. */
  permanent: boolean;
  providerMessageId?: string;
  error?: string;
}

/**
 * Thrown by a provider when the *whole batch* was rate-limited (HTTP 429 /
 * ThrottlingException). Signals the AIMD controller to back off and the worker to
 * retry the entire chunk — distinct from per-recipient failures.
 */
export class ThrottleError extends Error {
  constructor(message = "provider throttled") {
    super(message);
    this.name = "ThrottleError";
  }
}

export interface EmailProvider {
  readonly name: string;
  /** Hard cap on destinations per API call (SES=50, Resend=100, ...). */
  readonly maxBatchSize: number;
  /** Provider's max send rate/sec — the ceiling the AIMD controller ramps toward. */
  readonly ratePerSec: number;
  /**
   * Send one batch (length <= maxBatchSize). Resolves with a per-recipient result
   * array; throws ThrottleError if the batch as a whole was throttled.
   */
  sendBatch(messages: RenderedEmail[]): Promise<SendResult[]>;
}
