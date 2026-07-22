import { redis } from "../queue/connection.js";

/**
 * Live per-campaign counters in a Redis hash — the fast path for the progress UI.
 * These can drift on a crash; the reconciler periodically overwrites them from the
 * authoritative Postgres counts. UI reads these; truth is Postgres.
 */
export type CounterField =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "suppressed"
  | "delivered"
  | "bounced"
  | "complained"
  | "retried"
  | "dlq";

const key = (campaignId: string) => `campaign:${campaignId}:counters`;

export async function bumpCounters(
  campaignId: string,
  deltas: Partial<Record<CounterField, number>>,
): Promise<void> {
  const entries = Object.entries(deltas).filter(([, v]) => v);
  if (entries.length === 0) return;
  const pipe = redis.pipeline();
  for (const [field, delta] of entries) pipe.hincrby(key(campaignId), field, delta as number);
  pipe.pexpire(key(campaignId), 24 * 60 * 60 * 1000);
  await pipe.exec();
}

/** Overwrite counters from an authoritative snapshot (used by the reconciler). */
export async function setCounters(
  campaignId: string,
  values: Record<CounterField, number>,
): Promise<void> {
  await redis.hset(key(campaignId), values as Record<string, number>);
}

export async function getCounters(campaignId: string): Promise<Record<CounterField, number>> {
  const raw = await redis.hgetall(key(campaignId));
  const fields: CounterField[] = [
    "pending",
    "sending",
    "sent",
    "failed",
    "suppressed",
    "delivered",
    "bounced",
    "complained",
    "retried",
    "dlq",
  ];
  const out = {} as Record<CounterField, number>;
  for (const f of fields) out[f] = Number(raw[f] ?? 0);
  return out;
}
