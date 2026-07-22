import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconRefresh,
  IconPlayerPlay,
  IconPlayerPause,
  IconReload,
  IconBolt,
} from "@tabler/icons-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/api";
import type { CampaignView, EventRow } from "@/types";
import { fmt, fmtDuration, statusLabel, statusVariant } from "@/lib/format";

export function CampaignDetailSheet({
  id,
  onOpenChange,
  onChanged,
}: {
  id: string | null;
  onOpenChange: (o: boolean) => void;
  onChanged: () => void;
}) {
  const [view, setView] = useState<CampaignView | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [throughput, setThroughput] = useState(0);
  const prev = useRef<{ processed: number; t: number } | null>(null);

  useEffect(() => {
    if (!id) {
      setView(null);
      setEvents([]);
      setThroughput(0);
      prev.current = null;
      return;
    }
    const stop = api.stream(id, (v) => {
      setView(v);
      const now = Date.now();
      const processed = v.counters.sent + v.counters.failed + v.counters.suppressed;
      if (prev.current) {
        const dt = (now - prev.current.t) / 1000;
        if (dt > 0.4) {
          setThroughput(Math.max(0, Math.round((processed - prev.current.processed) / dt)));
          prev.current = { processed, t: now };
        }
      } else {
        prev.current = { processed, t: now };
      }
    });
    const loadEvents = () => api.getEvents(id).then(setEvents).catch(() => {});
    loadEvents();
    const t = setInterval(loadEvents, 2500);
    return () => {
      stop();
      clearInterval(t);
    };
  }, [id]);

  const c = view?.campaign;
  const counters = view?.counters;
  const status = c?.status ?? "draft";
  const pct = view ? view.progress * 100 : 0;

  const eta = useMemo(() => {
    if (!view || throughput <= 0) return null;
    const remaining = view.total - view.processed;
    return remaining > 0 ? remaining / throughput : null;
  }, [view, throughput]);

  const act = (fn: () => Promise<unknown>) => async () => {
    await fn().catch(() => {});
    onChanged();
  };

  const canStart = status === "draft" || status === "send_complete";
  const hasDlq = (counters?.dlq ?? 0) > 0;

  return (
    <Sheet open={!!id} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <div className="flex items-start justify-between gap-4 pr-8">
            <div className="min-w-0">
              <SheetTitle className="truncate">{c?.name ?? "…"}</SheetTitle>
              <p className="mt-1 truncate text-sm text-muted-foreground">{c?.subject}</p>
            </div>
            <Badge variant={statusVariant(status)}>{statusLabel(status)}</Badge>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={act(() => api.start(id!))} disabled={!id || !canStart}>
              <IconPlayerPlay size={15} /> {status === "send_complete" ? "Re-run" : "Start"}
            </Button>
            {status === "running" && (
              <Button size="sm" variant="secondary" onClick={act(() => api.pause(id!))}>
                <IconPlayerPause size={15} /> Pause
              </Button>
            )}
            {status === "paused" && (
              <Button size="sm" variant="secondary" onClick={act(() => api.resume(id!))}>
                <IconPlayerPlay size={15} /> Resume
              </Button>
            )}
            <Button
              size="sm"
              variant={hasDlq ? "default" : "outline"}
              onClick={act(() => api.retry(id!))}
              disabled={!hasDlq}
              title={hasDlq ? "Requeue dead-lettered recipients" : "No DLQ to retry"}
            >
              <IconReload size={15} /> Retry DLQ
            </Button>
            <Button size="sm" variant="ghost" onClick={() => id && api.getEvents(id).then(setEvents)}>
              <IconRefresh size={15} /> Refresh
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* progress */}
          <div>
            <div className="mb-1.5 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Progress</span>
              <span className="font-medium tabular-nums">{pct.toFixed(2)}%</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary to-emerald-400 transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground tabular-nums">
              {fmt(view?.processed ?? 0)} / {fmt(view?.total ?? 0)} processed
            </div>
          </div>

          {/* live rate row */}
          <div className="flex items-center gap-4 rounded-lg border border-border bg-secondary/40 px-4 py-3">
            <IconBolt size={20} className="text-primary" />
            <div className="flex-1">
              <div className="text-xs text-muted-foreground">Live throughput</div>
              <div className="text-xl font-bold tabular-nums">{fmt(throughput)}/s</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Target rate</div>
              <div className="text-sm font-medium tabular-nums">{fmt(view?.rate ?? 0)}/s</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground">ETA</div>
              <div className="text-sm font-medium tabular-nums">{eta == null ? "—" : fmtDuration(eta)}</div>
            </div>
          </div>

          {/* metrics grid */}
          {counters && (
            <div className="grid grid-cols-3 gap-2.5">
              <Metric label="Total" value={view!.total} />
              <Metric label="Processed" value={view!.processed} />
              <Metric label="Success (sent)" value={counters.sent} tone="green" />
              <Metric label="Delivered" value={counters.delivered} tone="blue" />
              <Metric label="Failed" value={counters.failed} tone="red" />
              <Metric label="Suppressed" value={counters.suppressed} tone="amber" />
              <Metric label="Retried" value={counters.retried} tone="amber" />
              <Metric label="DLQ" value={counters.dlq} tone={hasDlq ? "red" : undefined} />
              <Metric label="Bounced" value={counters.bounced} tone="red" />
              <Metric label="Complaints" value={counters.complained} tone="purple" />
              <Metric label="Sending" value={counters.sending} />
              <Metric label="Pending" value={counters.pending} />
            </div>
          )}

          {/* meta */}
          <div className="rounded-lg border border-border px-4 py-3 text-sm">
            <Row k="Provider" v={c?.provider ?? "—"} />
            <Row k="Total recipients" v={fmt(view?.total ?? 0)} />
            <Row k="Created" v={c ? new Date(c.createdAt).toLocaleString() : "—"} />
            {c?.startedAt && <Row k="Started" v={new Date(c.startedAt).toLocaleString()} />}
          </div>

          {/* recent events */}
          <div>
            <div className="mb-2 text-sm font-medium">Recent events</div>
            {events.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
                No events yet.
              </div>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto font-mono text-xs">
                {events.map((e) => (
                  <div key={e.id} className="flex items-center gap-3 border-b border-border/50 py-1.5">
                    <span className="text-muted-foreground">
                      {new Date(e.createdAt).toLocaleTimeString()}
                    </span>
                    <EventBadge type={e.type} />
                    <span className="truncate text-muted-foreground">#{e.recipientId} {reason(e.payload)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

const toneClass: Record<string, string> = {
  green: "text-emerald-400",
  blue: "text-sky-400",
  red: "text-red-400",
  amber: "text-amber-400",
  purple: "text-purple-400",
};

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-bold tabular-nums ${tone ? toneClass[tone] : ""}`}>
        {fmt(value)}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-medium">{v}</span>
    </div>
  );
}

function EventBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    fail: "text-red-400",
    bounce: "text-red-400",
    complaint: "text-purple-400",
    delivered: "text-sky-400",
  };
  return <span className={`font-semibold ${map[type] ?? "text-muted-foreground"}`}>{type}</span>;
}

function reason(p: unknown): string {
  if (p && typeof p === "object" && "reason" in p) return `· ${(p as { reason: string }).reason}`;
  return "";
}
