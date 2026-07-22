import { env } from "../config/env.js";
import { startProducer } from "./producer.js";
import { startSendWorker } from "./send.js";
import { startWebhookWorker } from "./webhook.js";
import { startReaper, stopReaper } from "./reaper.js";
import { startReconciler, stopReconciler } from "./reconciler.js";
import { startAimd, stopAimd } from "../control/aimd.js";
import { startBreaker, stopBreaker } from "../control/breaker.js";

/**
 * Worker process. Runs the queue consumers plus the single-instance control loops
 * (AIMD, breaker, reaper, reconciler). Scale send throughput with more worker
 * *processes* — the send worker is the only horizontally-scaled part; the control
 * loops are idempotent enough to run in each but are cheap and self-correcting.
 */
async function main() {
  console.log(`[worker] starting — provider=${env.PROVIDER} concurrency=${env.WORKER_CONCURRENCY}`);

  const producer = startProducer();
  const sender = startSendWorker();
  const webhook = startWebhookWorker();

  await startAimd();
  startBreaker();
  startReaper();
  startReconciler();

  const shutdown = async (sig: string) => {
    console.log(`[worker] ${sig} received — draining...`);
    stopAimd();
    stopBreaker();
    stopReaper();
    stopReconciler();
    // Close consumers gracefully: in-flight jobs finish, no new jobs are claimed.
    await Promise.allSettled([producer.close(), sender.close(), webhook.close()]);
    console.log("[worker] drained, exiting");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
