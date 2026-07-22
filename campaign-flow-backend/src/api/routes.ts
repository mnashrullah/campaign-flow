import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { events } from "../db/schema.js";
import { env } from "../config/env.js";
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  startCampaign,
  pauseCampaign,
  cancelCampaign,
  retryDlq,
} from "../services/campaigns.js";
import { generateRecipients } from "../services/recipients.js";
import { getCounters } from "../lib/counters.js";
import { getCurrentRate } from "../ratelimit/rateState.js";
import { webhookQueue } from "../queue/queues.js";
import { decodeUnsubscribeToken } from "../lib/email.js";
import { pool } from "../db/client.js";

const createSchema = z.object({
  name: z.string().min(1),
  subject: z.string().min(1),
  bodyTemplate: z.string().min(1),
  fromEmail: z.string().optional(),
  provider: z.enum(["dryrun", "ses", "resend"]).optional(),
});

async function buildView(id: string) {
  const campaign = await getCampaign(id);
  if (!campaign) return null;
  const counters = await getCounters(id);
  const total = campaign.totalRecipients || 0;
  const processed = counters.sent + counters.failed + counters.suppressed;
  const rate = await getCurrentRate();
  return {
    campaign,
    counters,
    rate,
    progress: total > 0 ? processed / total : 0,
    processed,
    total,
  };
}

export async function registerRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ ok: true, provider: env.PROVIDER }));

  // ---- campaigns -----------------------------------------------------------
  app.post("/campaigns", async (req, reply) => {
    const body = createSchema.parse(req.body);
    const campaign = await createCampaign({
      name: body.name,
      subject: body.subject,
      bodyTemplate: body.bodyTemplate,
      fromEmail: body.fromEmail ?? env.FROM_EMAIL,
      provider: body.provider ?? env.PROVIDER,
    });
    return reply.code(201).send(campaign);
  });

  app.get("/campaigns", async () => {
    const rows = await listCampaigns();
    // Attach live counters for the history list.
    return Promise.all(
      rows.map(async (c) => ({ ...c, counters: await getCounters(c.id) })),
    );
  });

  app.get("/campaigns/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = await buildView(id);
    if (!view) return reply.code(404).send({ error: "not found" });
    return view;
  });

  // Generate synthetic recipients (async — returns immediately, web polls total).
  app.post("/campaigns/:id/recipients", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { count } = z.object({ count: z.number().int().positive().max(5_000_000) }).parse(req.body);
    const campaign = await getCampaign(id);
    if (!campaign) return reply.code(404).send({ error: "not found" });
    if (campaign.status !== "draft") {
      return reply.code(409).send({ error: "recipients can only be generated for a draft campaign" });
    }
    // Fire-and-forget; 1M lands in a few seconds. Web polls total_recipients.
    void generateRecipients(id, count).catch((err) =>
      console.error(`[api] generateRecipients failed for ${id}`, err),
    );
    return reply.code(202).send({ ok: true, generating: count });
  });

  app.post("/campaigns/:id/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const campaign = await getCampaign(id);
    if (!campaign) return reply.code(404).send({ error: "not found" });
    await startCampaign(id);
    return { ok: true };
  });

  app.post("/campaigns/:id/pause", async (req) => {
    await pauseCampaign((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/campaigns/:id/resume", async (req) => {
    await startCampaign((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/campaigns/:id/cancel", async (req) => {
    await cancelCampaign((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/campaigns/:id/retry", async (req) => {
    const requeued = await retryDlq((req.params as { id: string }).id);
    return { ok: true, requeued };
  });

  app.get("/campaigns/:id/events", async (req) => {
    const { id } = req.params as { id: string };
    const rows = await db
      .select()
      .from(events)
      .where(eq(events.campaignId, id))
      .orderBy(desc(events.createdAt))
      .limit(100);
    return rows;
  });

  // ---- live progress (SSE) -------------------------------------------------
  app.get("/campaigns/:id/stream", async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": env.CORS_ORIGIN,
    });

    let closed = false;
    const send = async () => {
      if (closed) return;
      const view = await buildView(id);
      if (view) reply.raw.write(`data: ${JSON.stringify(view)}\n\n`);
    };
    await send();
    const interval = setInterval(() => void send(), 1000);

    req.raw.on("close", () => {
      closed = true;
      clearInterval(interval);
    });
  });

  // ---- provider webhooks ---------------------------------------------------
  // NOTE: signature verification (SNS / Resend) is required in production and is
  // documented in the README; omitted here for the demo.
  app.post("/webhooks/ses", async (req, reply) => {
    const body = req.body as any;
    // SNS subscription handshake.
    if (body?.Type === "SubscriptionConfirmation") {
      console.log("[webhook/ses] subscription confirmation — confirm SubscribeURL:", body.SubscribeURL);
      return reply.send({ ok: true });
    }
    const msg = typeof body?.Message === "string" ? JSON.parse(body.Message) : body;
    const messageId: string | undefined = msg?.mail?.messageId;
    const kind: string | undefined = msg?.eventType || msg?.notificationType;
    if (messageId && kind) {
      const type = mapSes(kind);
      if (type) {
        await webhookQueue.add("feedback", {
          campaignId: "",
          providerMessageId: messageId,
          type,
          providerEventId: `${messageId}:${type}`,
        });
      }
    }
    return reply.send({ ok: true });
  });

  app.post("/webhooks/resend", async (req, reply) => {
    const body = req.body as any;
    const messageId: string | undefined = body?.data?.email_id;
    const type = mapResend(body?.type);
    if (messageId && type) {
      await webhookQueue.add("feedback", {
        campaignId: "",
        providerMessageId: messageId,
        type,
        providerEventId: `${messageId}:${type}:${body?.created_at ?? ""}`,
      });
    }
    return reply.send({ ok: true });
  });

  // ---- unsubscribe (CAN-SPAM / one-click) ----------------------------------
  app.get("/unsubscribe", async (req, reply) => {
    const { t } = req.query as { t?: string };
    const decoded = t ? decodeUnsubscribeToken(t) : null;
    if (decoded) {
      await pool.query(
        `INSERT INTO suppression (email, reason) VALUES ($1, 'unsubscribe') ON CONFLICT DO NOTHING`,
        [decoded.email],
      );
    }
    reply.type("text/html").send(
      `<html><body style="font-family:sans-serif;text-align:center;padding:3rem">
         <h2>You're unsubscribed</h2>
         <p>${decoded ? decoded.email : "This request"} will no longer receive these emails.</p>
       </body></html>`,
    );
  });
  // POST variant for RFC 8058 one-click.
  app.post("/unsubscribe", async (req, reply) => {
    const { t } = req.query as { t?: string };
    const decoded = t ? decodeUnsubscribeToken(t) : null;
    if (decoded) {
      await pool.query(
        `INSERT INTO suppression (email, reason) VALUES ($1, 'unsubscribe') ON CONFLICT DO NOTHING`,
        [decoded.email],
      );
    }
    return reply.code(200).send({ ok: true });
  });
}

function mapSes(kind: string): "delivered" | "bounce" | "complaint" | null {
  const k = kind.toLowerCase();
  if (k === "delivery") return "delivered";
  if (k === "bounce") return "bounce";
  if (k === "complaint") return "complaint";
  return null;
}

function mapResend(type?: string): "delivered" | "bounce" | "complaint" | null {
  switch (type) {
    case "email.delivered":
      return "delivered";
    case "email.bounced":
      return "bounce";
    case "email.complained":
      return "complaint";
    default:
      return null;
  }
}
