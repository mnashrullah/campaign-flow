import { existsSync } from "node:fs";
import { z } from "zod";

// Load .env for local dev (Node built-in; no dotenv dependency). In Docker the
// vars come from compose, so a missing .env file is fine.
if (existsSync(".env")) process.loadEnvFile(".env");

/**
 * Central, validated configuration.
 *
 * Everything that governs throughput, failure behaviour and provider selection is
 * an env var with a sane default, so the same build runs as a fast dry-run on a
 * laptop or a real SES/Resend blast on a VPS with only .env changes.
 */

const numeric = (def: number) =>
  z.coerce.number().refine((n) => !Number.isNaN(n), "must be a number").default(def);
const fraction = (def: number) => z.coerce.number().min(0).max(1).default(def);

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: numeric(4000),
  CORS_ORIGIN: z.string().default("*"),

  DATABASE_URL: z
    .string()
    .default("postgres://campaign:campaign@localhost:5432/campaign_flow"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // ---- Active provider ----------------------------------------------------
  // The engine is provider-agnostic; this only selects which adapter runs.
  PROVIDER: z.enum(["dryrun", "ses", "resend"]).default("dryrun"),

  // ---- Sending shape (shared across providers) ----------------------------
  // A queue "chunk" is a unit of work for one job; a provider "batch" is one API
  // call. One chunk fans into ceil(CHUNK_SIZE / provider.maxBatchSize) API calls.
  CHUNK_SIZE: numeric(500),
  WORKER_CONCURRENCY: numeric(24),
  MAX_ATTEMPTS: numeric(3), // transient failures retried up to this many times, then DLQ
  CLAIM_TIMEOUT_MS: numeric(120_000), // a "sending" row older than this is reaped

  FROM_EMAIL: z.string().default("Campaign Flow <no-reply@example.com>"),
  UNSUBSCRIBE_BASE_URL: z.string().default("http://localhost:4000/unsubscribe"),

  // ---- Per-provider limits (the AIMD ceiling + batch size) ----------------
  DRYRUN_RATE_PER_SEC: numeric(2000), // max_rate ceiling for dry-run
  DRYRUN_MAX_BATCH: numeric(100),
  SES_RATE_PER_SEC: numeric(14), // SES production default; raise as quota is granted
  SES_MAX_BATCH: numeric(50), // SendBulkEmail hard cap
  SES_REGION: z.string().default("us-east-1"),
  SES_CONFIGURATION_SET: z.string().optional(),
  RESEND_RATE_PER_SEC: numeric(10),
  RESEND_MAX_BATCH: numeric(100), // batch endpoint hard cap
  RESEND_API_KEY: z.string().optional(),

  // ---- Dry-run simulation knobs (all fractions of messages) ---------------
  // These let the dry-run exercise every real code path without sending mail.
  DRYRUN_LATENCY_MS: numeric(25), // simulated per-batch API latency
  DRYRUN_INVALID_RATE: fraction(0.01), // caught by validation -> permanent fail, no retry
  DRYRUN_TRANSIENT_ERROR_RATE: fraction(0.02), // 5xx-style -> retried
  DRYRUN_HARD_FAIL_RATE: fraction(0.005), // provider rejects at send -> permanent fail
  DRYRUN_BOUNCE_RATE: fraction(0.01), // async bounce webhook after "sent" (< 5% breaker)
  DRYRUN_COMPLAINT_RATE: fraction(0.0002), // async complaint (< 0.1% breaker; raise to trip it)
  DRYRUN_THROTTLE_RATE: fraction(0.0), // batch throttled (429) -> AIMD backs off

  // ---- AIMD throughput controller -----------------------------------------
  AIMD_ENABLED: z.coerce.boolean().default(true),
  AIMD_TICK_MS: numeric(2000),
  AIMD_START_RATE: numeric(200), // initial send rate; ramps toward provider ceiling
  AIMD_MIN_RATE: numeric(50),
  AIMD_INCREASE_STEP: numeric(200), // additive increase per clean tick
  AIMD_DECREASE_FACTOR: fraction(0.5), // multiplicative decrease on throttle

  // ---- Reputation circuit-breaker -----------------------------------------
  BREAKER_ENABLED: z.coerce.boolean().default(true),
  BREAKER_BOUNCE_THRESHOLD: fraction(0.05), // >5% hard bounces -> trip
  BREAKER_COMPLAINT_THRESHOLD: fraction(0.001), // >0.1% complaints -> trip
  BREAKER_MIN_SAMPLE: numeric(500), // need this many delivered before it can trip
  BREAKER_COOLDOWN_MS: numeric(30_000), // OPEN -> HALF_OPEN wait

  // ---- Background loops ----------------------------------------------------
  REAPER_TICK_MS: numeric(15_000),
  RECONCILER_TICK_MS: numeric(10_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** Resolved limits for the currently-selected provider. */
export function activeProviderLimits() {
  switch (env.PROVIDER) {
    case "ses":
      return { ratePerSec: env.SES_RATE_PER_SEC, maxBatch: env.SES_MAX_BATCH };
    case "resend":
      return { ratePerSec: env.RESEND_RATE_PER_SEC, maxBatch: env.RESEND_MAX_BATCH };
    case "dryrun":
    default:
      return { ratePerSec: env.DRYRUN_RATE_PER_SEC, maxBatch: env.DRYRUN_MAX_BATCH };
  }
}
