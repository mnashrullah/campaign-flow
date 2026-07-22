import { redis } from "../queue/connection.js";
import { env, activeProviderLimits } from "../config/env.js";

/**
 * Rate-control state shared across all workers and the AIMD controller. The
 * "account" is the provider — rate limit is an account-level resource shared by
 * every campaign, so the bucket and current rate are keyed per provider, not per
 * campaign.
 */
export const account = env.PROVIDER;

export const KEY_BUCKET = `rate:${account}:bucket`;
const KEY_RATE = `rate:${account}:rate`;
const KEY_THROTTLE = `rate:${account}:throttle`;

/** Current effective send rate (tokens/sec). Falls back to the provider ceiling. */
export async function getCurrentRate(): Promise<number> {
  const v = await redis.get(KEY_RATE);
  if (v == null) return activeProviderLimits().ratePerSec;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : activeProviderLimits().ratePerSec;
}

export async function setCurrentRate(rate: number): Promise<void> {
  await redis.set(KEY_RATE, String(rate));
}

/** Workers call this when a batch is throttled; the AIMD tick reads + resets it. */
export async function signalThrottle(): Promise<void> {
  await redis.incr(KEY_THROTTLE);
}

/** Atomically read and clear the throttle counter for one controller tick. */
export async function drainThrottleSignals(): Promise<number> {
  const v = await redis.getdel(KEY_THROTTLE);
  return v ? Number(v) : 0;
}
