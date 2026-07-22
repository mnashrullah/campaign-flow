# Campaign Flow — Design & Failure-Mode Analysis

This document captures the reasoning behind the system: the core insight, the throughput strategy, the data lifecycle and correctness argument, the two control loops, and the full set of failure modes (with which are handled in code vs. documented as real-world prerequisites).

---

## 1. The core insight

**The email provider's rate limit and deliverability are the bottleneck — not the code.**

At 1M recipients, wall-clock time is `1,000,000 / granted_rate`. A perfectly optimized loop against a 14/sec SES quota still takes ~20 hours; a mediocre loop against a 2,000/sec quota finishes in ~8 minutes. So the engineering goal is:

1. **Saturate** whatever rate the provider grants (discover it adaptively).
2. **Back off** gracefully when throttled — never hammer into 429s.
3. **Never double-send** on retries/crashes.
4. **Protect the sending reputation** — a bad list can get the whole account suspended.
5. Show **honest** real-time progress.

The dry-run provider lets us prove all of this without sending mail: it simulates latency and every failure mode, so the only real work is DB writes, and 1M completes in ~10 minutes.

---

## 2. Throughput strategy

- **Chunk jobs, not 1M jobs.** The producer fans a campaign into ~2,000 id-range chunk jobs (500 recipients each). Enqueuing a million individual jobs would itself be the bottleneck; id-ranges mean the producer never loads rows into memory.
- **Two-level batching.** One chunk (500) → several provider **batch** API calls (SES 50/call, Resend 100/call). Fewer HTTP round-trips.
- **Global token bucket.** A single Redis Lua token bucket, keyed **per provider account** (rate limit is account-level, shared across campaigns). Every worker calls it before each batch, so N workers collectively respect one rate rather than each racing "as fast as possible."
- **Streaming everywhere.** Seeding uses Postgres `generate_series` (server-side); claiming reads id-ranges. Nothing buffers 1M rows in Node.

---

## 3. Data lifecycle & correctness

### Two orthogonal status axes

Send and delivery are separate timelines — a row can be `sent` (API accepted) and then `bounced` 30s later. So each recipient carries **two** fields instead of one flip-flopping column:

```
send_status:      pending → sending → sent | failed | suppressed
delivery_status:  unknown → delivered | bounced | complained
```

`sent` = provider's API returned OK (handed off, not delivered). `delivery_status` only advances via async webhooks.

### The chunk transaction (no double-count)

Per chunk, in one transaction:

```sql
UPDATE recipients SET send_status='sent', provider_message_id=...
 WHERE id = ANY(batch) AND send_status='sending'   -- conditional = idempotent
 RETURNING id;                                       -- delta = rows ACTUALLY changed
UPDATE campaign_stats SET sent = sent + :changed;    -- increment by real delta
```

Because the increment is tied to the rows the conditional UPDATE actually changed, **reprocessing a chunk after a retry cannot double-count**. Postgres stays internally consistent without ever running a giant `COUNT`.

### Claiming (idempotent, lock-safe)

```sql
UPDATE recipients SET send_status='sending', claimed_at=now(), attempts=attempts+1
 WHERE id IN (SELECT id FROM recipients
              WHERE campaign_id=$1 AND id BETWEEN $2 AND $3 AND send_status='pending'
              FOR UPDATE SKIP LOCKED)
 RETURNING ...;
```

`FOR UPDATE SKIP LOCKED` lets concurrent workers claim disjoint rows without blocking.

### Retry / DLQ

Per-recipient `attempts`. Transient failures (5xx / network) → back to `pending` and re-enqueued as a continuation; once `attempts >= MAX_ATTEMPTS` → `failed` (the DLQ). Permanent failures (invalid address, hard bounce) → `failed` immediately, no retry. Throttled batches revert to `pending` **without** burning an attempt (not the recipient's fault) and signal AIMD.

### Reaper (crash recovery)

A worker that dies mid-batch leaves rows in `sending`. The reaper resets rows claimed longer than `CLAIM_TIMEOUT_MS` back to `pending` (or `failed` if exhausted) and re-enqueues their range. **Caveat:** if the worker *did* send before crashing, this re-sends — the system is **at-least-once**, minimized by passing an idempotency key to the provider. Stated honestly, not hidden.

### Reconciler (drift self-heal)

Three tiers, cheap → authoritative:
1. **Redis counters** — hot path for the live UI (can drift on a crash).
2. **`campaign_stats`** — updated transactionally per chunk (consistent working truth).
3. **Periodic audit** — `COUNT(*) GROUP BY status` recomputes from recipient rows and overwrites both if they disagree. Self-heals any drift; also keeps `pending`/`sending` accurate for the UI.

### Webhook ingest (async hazards)

- **Out-of-order:** a delivery event can arrive before our own `sent` commit → resolve the recipient by `provider_message_id`, retry if not found yet.
- **At-least-once:** duplicate events de-duped by a unique `provider_event_id` → replays are no-ops.
- **Monotonic:** a `bounced` is never downgraded back to `delivered` by a late event.

---

## 4. The two control loops

They optimize opposite things, so precedence matters: **reputation wins over throughput.**

### AIMD throughput controller

- **Additive increase:** while sending cleanly, raise the rate by a fixed step each tick, ramping toward the provider ceiling — discovers the usable rate without knowing the exact quota.
- **Multiplicative decrease:** on any throttle signal, halve the rate immediately.
- **Feedback-gated:** only ramps up while a campaign is actually running, so the rate doesn't silently climb to max while idle and then blast.
- Runs single-instance (a controller tick); workers only *report* throttle signals into Redis.

### Reputation circuit-breaker

Watches each running campaign's bounce/complaint rate and **auto-pauses** it on breach — this is what prevents account suspension on a bad list.

```
CLOSED  --breach(≥ min sample)-->  OPEN (auto-pause)
OPEN    --cooldown elapsed------>  HALF_OPEN (resume at reduced rate)
HALF_OPEN --clean window-------->  CLOSED
HALF_OPEN --breach again-------->  OPEN
```

Thresholds default to bounce > 5%, complaint > 0.1%, with a minimum sample so a couple of early bounces don't trip it. **Async-feedback caveat:** bounces arrive seconds later, so the breaker reacts with some lag — mitigated by the min-sample gate and the feedback-gated AIMD ramp. Documented, not pretended away.

---

## 5. Failure modes

### Deliverability & reputation (the scary ones)

| Failure | Trigger | Blast radius | Mitigation |
|---|---|---|---|
| Account suspended | hard-bounce rate > 10% | entire account paused | circuit-breaker auto-pause + list validation + suppression |
| Deliverability collapse | complaint rate > 0.3% | Gmail/Yahoo spam-folder everything | breaker + suppression + one-click unsubscribe |
| IP blocklisted | cold-IP blast / spam traps | weeks to recover | **warmup** (documented) + AIMD ramp shapes the send |
| Can't send at all | sandbox not exited / low quota | 20+ hrs or impossible | documented quota process |

### System / infra

- **Redis SPOF** → AOF persistence (queue + rate state survive restart).
- **Postgres connection exhaustion** → shared pool sized above worker concurrency.
- **Graceful shutdown** → SIGTERM drains in-flight jobs; reaper recovers the rest.
- **Observability** → the live progress UI *is* the monitoring (rate, errors, queue depth, ETA).

### Data quality

- Invalid/malformed addresses → validated before send (bad addresses spike bounce rate).
- Personalization injection → all interpolated values HTML-escaped.

---

## 6. Compliance (legal surface, not polish)

- **Gmail/Yahoo bulk-sender rules (Feb 2024):** SPF+DKIM+DMARC, **one-click unsubscribe** (RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`), complaint rate < 0.3%. Mandatory at 1M.
- **CAN-SPAM:** accurate headers, physical postal address, honor unsubscribes.
- **GDPR/PECR/CASL:** lawful basis (consent), right to erasure, data minimization.

**Built:** unsubscribe token + one-click `List-Unsubscribe` header (Resend adapter) + suppression enforcement + physical-address footer in the template. **Sender's responsibility (documented):** proving consent for the 1M list.

---

## 7. Quota & cost

- **SES:** sandbox = 1/sec, 200/day. Production starts ~14/sec, ~50k/day; both the **per-second rate** and the **24-hour quota** must be raised (gradually, reputation-based) to hit 1M/run. Cost ~$0.10/1,000 → **~$100 per 1M**.
- **Resend:** batch ≤ 100, per-plan rate/volume caps; 1M needs a scale/enterprise plan. Better DX, higher per-unit cost.
- **Infra:** a single ~€7/mo Hetzner CX32 runs the whole stack — because the provider, not our servers, is the ceiling.

---

## 8. Known limitations / next steps

- At-least-once delivery (not exactly-once) — acceptable for promotional mail; would need provider-side idempotency + a dedupe window for stronger guarantees.
- Webhook signature verification is stubbed (mapping implemented) — production must verify SNS / Resend signatures.
- `events` table would be **partitioned by campaign** at true scale for cheap retention (`DROP PARTITION`); here it's indexed with a `retention_days` note.
- Control loops run per worker process; they're cheap and self-correcting, but a leader-election would make them strictly single-instance in a multi-worker cluster.
