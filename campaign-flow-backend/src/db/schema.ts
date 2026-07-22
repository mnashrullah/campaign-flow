import {
  pgTable,
  pgEnum,
  uuid,
  text,
  bigint,
  bigserial,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Drizzle table definitions for typed queries. The authoritative DDL (indexes,
 * partial unique indexes) lives in schema.sql; this mirrors it for the ORM.
 */

export const campaignStatus = pgEnum("campaign_status", [
  "draft",
  "running",
  "paused",
  "send_complete",
  "settled",
  "cancelled",
]);

export const sendStatus = pgEnum("send_status", [
  "pending",
  "sending",
  "sent",
  "failed",
  "suppressed",
]);

export const deliveryStatus = pgEnum("delivery_status", [
  "unknown",
  "delivered",
  "bounced",
  "complained",
]);

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  bodyTemplate: text("body_template").notNull(),
  fromEmail: text("from_email").notNull(),
  provider: text("provider").notNull(),
  status: campaignStatus("status").notNull().default("draft"),
  totalRecipients: bigint("total_recipients", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const recipients = pgTable("recipients", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  campaignId: uuid("campaign_id").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  sendStatus: sendStatus("send_status").notNull().default("pending"),
  deliveryStatus: deliveryStatus("delivery_status").notNull().default("unknown"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  idempotencyKey: text("idempotency_key").notNull(),
  providerMessageId: text("provider_message_id"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  campaignId: uuid("campaign_id").notNull(),
  recipientId: bigint("recipient_id", { mode: "number" }),
  type: text("type").notNull(),
  providerEventId: text("provider_event_id"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const campaignStats = pgTable("campaign_stats", {
  campaignId: uuid("campaign_id").primaryKey(),
  pending: bigint("pending", { mode: "number" }).notNull().default(0),
  sending: bigint("sending", { mode: "number" }).notNull().default(0),
  sent: bigint("sent", { mode: "number" }).notNull().default(0),
  failed: bigint("failed", { mode: "number" }).notNull().default(0),
  suppressed: bigint("suppressed", { mode: "number" }).notNull().default(0),
  delivered: bigint("delivered", { mode: "number" }).notNull().default(0),
  bounced: bigint("bounced", { mode: "number" }).notNull().default(0),
  complained: bigint("complained", { mode: "number" }).notNull().default(0),
  retried: bigint("retried", { mode: "number" }).notNull().default(0),
  dlq: bigint("dlq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const suppression = pgTable("suppression", {
  email: text("email").primaryKey(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Campaign = typeof campaigns.$inferSelect;
export type Recipient = typeof recipients.$inferSelect;
export type CampaignStats = typeof campaignStats.$inferSelect;
