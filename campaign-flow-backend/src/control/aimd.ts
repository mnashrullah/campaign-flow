import { env, activeProviderLimits } from "../config/env.js";
import { pool } from "../db/client.js";
import { getCurrentRate, setCurrentRate, drainThrottleSignals } from "../ratelimit/rateState.js";

/**
 * AIMD throughput controller (single instance in the worker process).
 *
 *   - Additive increase: while sending cleanly, raise the rate by a fixed step
 *     each tick, ramping toward the provider ceiling — this discovers the true
 *     usable rate without knowing the exact granted quota.
 *   - Multiplicative decrease: on any throttle signal, halve the rate immediately.
 *
 * Increase is feedback-gated: we only ramp up while a campaign is actually
 * running, so the rate doesn't silently climb to max while idle and then blast.
 */
let timer: NodeJS.Timeout | null = null;

export async function startAimd(): Promise<void> {
  const ceiling = activeProviderLimits().ratePerSec;
  if (!env.AIMD_ENABLED) {
    await setCurrentRate(ceiling); // fixed-rate mode: pin at the provider ceiling
    return;
  }
  await setCurrentRate(Math.min(env.AIMD_START_RATE, ceiling));
  timer = setInterval(() => void tick(ceiling), env.AIMD_TICK_MS);
  console.log(`[aimd] started: start=${env.AIMD_START_RATE}/s ceiling=${ceiling}/s`);
}

async function tick(ceiling: number): Promise<void> {
  try {
    const throttles = await drainThrottleSignals();
    let rate = await getCurrentRate();

    if (throttles > 0) {
      rate = Math.max(env.AIMD_MIN_RATE, Math.floor(rate * env.AIMD_DECREASE_FACTOR));
      console.log(`[aimd] throttled x${throttles} -> decrease to ${rate}/s`);
    } else if (await hasRunningCampaign()) {
      rate = Math.min(ceiling, rate + env.AIMD_INCREASE_STEP);
    }
    await setCurrentRate(rate);
  } catch (err) {
    console.error("[aimd] tick error", err);
  }
}

async function hasRunningCampaign(): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM campaigns WHERE status = 'running' LIMIT 1`);
  return rows.length > 0;
}

export function stopAimd(): void {
  if (timer) clearInterval(timer);
}
