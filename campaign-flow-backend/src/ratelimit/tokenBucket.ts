import { Redis } from "ioredis";
import { redis } from "../queue/connection.js";

/**
 * Global distributed token bucket (atomic Lua). Every worker calls take() before
 * sending a batch, so N workers collectively respect ONE send rate rather than
 * each racing to "as fast as possible" and tripping provider throttling.
 *
 * The refill rate is passed per call, so the AIMD controller can raise/lower the
 * effective rate live simply by changing the value it stores in Redis.
 */
const LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end

local delta = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + delta * rate)

local allowed = 0
local wait = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
else
  wait = math.ceil(((requested - tokens) / rate) * 1000.0)
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, 60000)
return {allowed, wait}
`;

interface BucketRedis extends Redis {
  tokenBucket(
    key: string,
    rate: number,
    capacity: number,
    now: number,
    requested: number,
  ): Promise<[number, number]>;
}

const client = redis as BucketRedis;
client.defineCommand("tokenBucket", { numberOfKeys: 1, lua: LUA });

export interface TakeResult {
  allowed: boolean;
  waitMs: number;
}

export async function takeTokens(
  key: string,
  rate: number,
  requested: number,
): Promise<TakeResult> {
  // Capacity = ~1s of burst, floored so a low rate can still admit one batch.
  const capacity = Math.max(rate, requested);
  const [allowed, wait] = await client.tokenBucket(key, rate, capacity, Date.now(), requested);
  return { allowed: allowed === 1, waitMs: wait };
}
