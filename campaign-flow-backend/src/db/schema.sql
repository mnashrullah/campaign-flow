-- Campaign Flow schema. Idempotent: safe to run repeatedly (migrate.ts runs it on boot).

-- ---- enums -----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE campaign_status AS ENUM
    ('draft','running','paused','send_complete','settled','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE send_status AS ENUM ('pending','sending','sent','failed','suppressed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE delivery_status AS ENUM ('unknown','delivered','bounced','complained');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- campaigns -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  subject          TEXT NOT NULL,
  body_template    TEXT NOT NULL,              -- HTML with {{name}} etc.
  from_email       TEXT NOT NULL,
  provider         TEXT NOT NULL,              -- snapshot of the provider used
  status           campaign_status NOT NULL DEFAULT 'draft',
  total_recipients BIGINT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ
);

-- ---- recipients ------------------------------------------------------------
-- send_status and delivery_status are two orthogonal timelines (a row can be
-- 'sent' then later 'bounced'). idempotency_key guards against double-send.
CREATE TABLE IF NOT EXISTS recipients (
  id               BIGSERIAL PRIMARY KEY,
  campaign_id      UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  send_status      send_status NOT NULL DEFAULT 'pending',
  delivery_status  delivery_status NOT NULL DEFAULT 'unknown',
  attempts         INT NOT NULL DEFAULT 0,
  last_error       TEXT,
  idempotency_key  TEXT NOT NULL,
  provider_message_id TEXT,
  claimed_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chunk claiming reads (campaign_id, send_status) ranges — the hot path index.
CREATE INDEX IF NOT EXISTS idx_recipients_campaign_status
  ON recipients (campaign_id, send_status, id);
-- Dedupe within a campaign + idempotency lookups.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recipients_campaign_key
  ON recipients (campaign_id, idempotency_key);
-- Webhooks arrive keyed by provider_message_id.
CREATE INDEX IF NOT EXISTS idx_recipients_provider_msg
  ON recipients (provider_message_id);

-- ---- events (append-only audit log) ---------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id                BIGSERIAL PRIMARY KEY,
  campaign_id       UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  recipient_id      BIGINT,
  type              TEXT NOT NULL,            -- sent | delivered | bounce | complaint | fail
  provider_event_id TEXT,                     -- dedupe key for at-least-once webhooks
  payload           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events (campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_recipient ON events (recipient_id);
-- Idempotent webhook ingest: duplicate provider_event_id is a no-op. A full
-- unique index (not partial) so ON CONFLICT (provider_event_id) can infer it;
-- Postgres treats NULLs as distinct, so failure events (NULL id) never collide.
DROP INDEX IF EXISTS uq_events_provider_event;
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_provider_event
  ON events (provider_event_id);

-- ---- campaign_stats (rolled-up counters, transactionally consistent) -------
CREATE TABLE IF NOT EXISTS campaign_stats (
  campaign_id  UUID PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  pending      BIGINT NOT NULL DEFAULT 0,
  sending      BIGINT NOT NULL DEFAULT 0,
  sent         BIGINT NOT NULL DEFAULT 0,
  failed       BIGINT NOT NULL DEFAULT 0,
  suppressed   BIGINT NOT NULL DEFAULT 0,
  delivered    BIGINT NOT NULL DEFAULT 0,
  bounced      BIGINT NOT NULL DEFAULT 0,
  complained   BIGINT NOT NULL DEFAULT 0,
  retried      BIGINT NOT NULL DEFAULT 0,  -- recipients retried at least once
  dlq          BIGINT NOT NULL DEFAULT 0,  -- failed after exhausting retries (dead-letter)
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Additive columns for existing databases.
ALTER TABLE campaign_stats ADD COLUMN IF NOT EXISTS retried BIGINT NOT NULL DEFAULT 0;
ALTER TABLE campaign_stats ADD COLUMN IF NOT EXISTS dlq BIGINT NOT NULL DEFAULT 0;

-- ---- suppression list ------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppression (
  email       TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,                  -- bounce | complaint | unsubscribe | manual
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
