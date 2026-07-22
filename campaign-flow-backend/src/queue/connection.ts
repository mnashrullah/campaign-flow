import { Redis } from "ioredis";
import { env } from "../config/env.js";

/**
 * BullMQ requires `maxRetriesPerRequest: null` on its connection. We keep a small
 * set of shared connections rather than one-per-queue to stay well under Redis'
 * client limits when workers scale.
 */
export function createRedis(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

// A general-purpose connection for counters, rate-limiter and control-plane keys
// (not owned by BullMQ). Workers/queues create their own via createRedis().
export const redis = createRedis();
