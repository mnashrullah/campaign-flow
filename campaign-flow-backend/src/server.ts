import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./config/env.js";
import { registerRoutes } from "./api/routes.js";

/**
 * API server. Serves campaign CRUD, control actions, SSE progress and provider
 * webhooks. Sending happens in the separate worker process — this process stays
 * responsive regardless of send load.
 */
async function main() {
  const app = Fastify({ logger: { level: env.NODE_ENV === "production" ? "info" : "warn" } });

  await app.register(cors, { origin: env.CORS_ORIGIN, methods: ["GET", "POST"] });
  await registerRoutes(app);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err.statusCode === 400 || err.name === "ZodError") {
      return reply.code(400).send({ error: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  console.log(`[api] listening on :${env.PORT} (provider=${env.PROVIDER})`);

  const shutdown = async (sig: string) => {
    console.log(`[api] ${sig} — closing`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[api] fatal", err);
  process.exit(1);
});
