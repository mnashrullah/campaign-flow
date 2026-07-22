import { env } from "../config/env.js";
import { redis } from "../queue/connection.js";
import { pool } from "../db/client.js";
import { getCounters } from "../lib/counters.js";
import { setCurrentRate } from "../ratelimit/rateState.js";
import { pauseCampaign, startCampaign, getCampaign } from "../services/campaigns.js";

/**
 * Reputation circuit-breaker (single instance). Watches each running campaign's
 * bounce/complaint rate and AUTO-PAUSES it when a threshold is breached — this is
 * what protects the sending account from suspension on a bad list.
 *
 *   CLOSED  --breach(min sample)-->  OPEN (auto-pause)
 *   OPEN    --cooldown elapsed---->  HALF_OPEN (auto-resume at reduced rate)
 *   HALF_OPEN --clean window----->  CLOSED
 *   HALF_OPEN --breach again----->  OPEN
 *
 * Because bounces arrive asynchronously (webhooks, seconds later), the breaker
 * reacts with some lag — a real limitation we accept and document, mitigated by
 * the min-sample gate and the feedback-gated AIMD ramp.
 */
interface BreakerState {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  openedAt: number;
  baseDelivered: number;
  baseBounced: number;
  baseComplained: number;
}

let timer: NodeJS.Timeout | null = null;
const stateKey = (id: string) => `breaker:${id}`;

export function startBreaker(): void {
  if (!env.BREAKER_ENABLED) return;
  timer = setInterval(() => void tick(), 2000);
  console.log(
    `[breaker] started: bounce>${env.BREAKER_BOUNCE_THRESHOLD} ` +
      `complaint>${env.BREAKER_COMPLAINT_THRESHOLD} minSample=${env.BREAKER_MIN_SAMPLE}`,
  );
}

async function tick(): Promise<void> {
  try {
    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM campaigns WHERE status IN ('running','paused')`,
    );
    for (const row of rows) await evaluate(row.id, row.status);
  } catch (err) {
    console.error("[breaker] tick error", err);
  }
}

async function readState(id: string): Promise<BreakerState> {
  const h = await redis.hgetall(stateKey(id));
  return {
    state: (h.state as BreakerState["state"]) || "CLOSED",
    openedAt: Number(h.openedAt ?? 0),
    baseDelivered: Number(h.baseDelivered ?? 0),
    baseBounced: Number(h.baseBounced ?? 0),
    baseComplained: Number(h.baseComplained ?? 0),
  };
}

async function writeState(id: string, s: BreakerState): Promise<void> {
  await redis.hset(stateKey(id), s as unknown as Record<string, number | string>);
}

function breaches(delivered: number, bounced: number, complained: number): boolean {
  const sample = delivered + bounced + complained;
  if (sample <= 0) return false;
  return (
    bounced / sample > env.BREAKER_BOUNCE_THRESHOLD ||
    complained / sample > env.BREAKER_COMPLAINT_THRESHOLD
  );
}

async function evaluate(id: string, status: string): Promise<void> {
  const s = await readState(id);
  const c = await getCounters(id);
  const sampleTotal = c.delivered + c.bounced + c.complained;

  if (status === "running" && s.state === "CLOSED") {
    if (sampleTotal >= env.BREAKER_MIN_SAMPLE && breaches(c.delivered, c.bounced, c.complained)) {
      await trip(id, c);
    }
    return;
  }

  if (s.state === "OPEN") {
    if (Date.now() - s.openedAt >= env.BREAKER_COOLDOWN_MS) {
      // Half-open: resume at a reduced rate and watch the *incremental* window.
      await writeState(id, {
        state: "HALF_OPEN",
        openedAt: s.openedAt,
        baseDelivered: c.delivered,
        baseBounced: c.bounced,
        baseComplained: c.complained,
      });
      await setCurrentRate(env.AIMD_MIN_RATE);
      const camp = await getCampaign(id);
      if (camp && camp.status === "paused") await startCampaign(id);
      console.log(`[breaker] ${id} OPEN -> HALF_OPEN (resume at reduced rate)`);
    }
    return;
  }

  if (s.state === "HALF_OPEN") {
    const wd = c.delivered - s.baseDelivered;
    const wb = c.bounced - s.baseBounced;
    const wc = c.complained - s.baseComplained;
    const windowSample = wd + wb + wc;
    if (windowSample >= env.BREAKER_MIN_SAMPLE) {
      if (breaches(wd, wb, wc)) {
        await trip(id, c); // re-trip; stays paused until it recovers or manual resume
        console.log(`[breaker] ${id} HALF_OPEN -> OPEN (re-tripped)`);
      } else {
        await writeState(id, { ...s, state: "CLOSED" });
        console.log(`[breaker] ${id} HALF_OPEN -> CLOSED (recovered)`);
      }
    }
  }
}

async function trip(id: string, c: { delivered: number; bounced: number; complained: number }): Promise<void> {
  const camp = await getCampaign(id);
  if (camp && camp.status === "running") await pauseCampaign(id);
  await setCurrentRate(env.AIMD_MIN_RATE);
  await writeState(id, {
    state: "OPEN",
    openedAt: Date.now(),
    baseDelivered: c.delivered,
    baseBounced: c.bounced,
    baseComplained: c.complained,
  });
  const sample = c.delivered + c.bounced + c.complained || 1;
  console.warn(
    `[breaker] ALERT campaign ${id} TRIPPED -> auto-paused. ` +
      `bounce=${((c.bounced / sample) * 100).toFixed(2)}% complaint=${((c.complained / sample) * 100).toFixed(3)}%`,
  );
}

export function stopBreaker(): void {
  if (timer) clearInterval(timer);
}
