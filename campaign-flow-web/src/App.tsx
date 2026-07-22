import { useEffect, useMemo, useState } from "react";
import {
  IconSearch,
  IconPlus,
  IconEye,
  IconPlayerPlay,
  IconMailFast,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateCampaignDialog } from "@/components/CreateCampaignDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CampaignDetailSheet } from "@/components/CampaignDetailSheet";
import { api } from "@/api";
import type { CampaignListItem } from "@/types";
import { fmt, relTime, statusLabel, statusVariant } from "@/lib/format";

export function App() {
  const [items, setItems] = useState<CampaignListItem[]>([]);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [startTarget, setStartTarget] = useState<CampaignListItem | null>(null);

  const load = () => api.listCampaigns().then((r) => setItems(r.reverse())).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  // Client-side filter (not an API call), by campaign name.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((c) => c.name.toLowerCase().includes(q)) : items;
  }, [items, query]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* header */}
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <IconMailFast size={22} />
          </div>
          <div>
            <h1 className="text-xl font-bold leading-tight">Campaign Flow</h1>
            <p className="text-xs text-muted-foreground">1M-scale email engine</p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <IconPlus size={18} /> New campaign
        </Button>
      </div>

      {/* search */}
      <div className="relative mb-4 max-w-sm">
        <IconSearch size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search campaigns by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* table */}
      <div className="rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Campaign</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[220px]">Progress</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-14 text-center text-muted-foreground">
                  {items.length === 0 ? "No campaigns yet — create your first one." : "No matches."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((c) => {
                const processed = c.counters.sent + c.counters.failed + c.counters.suppressed;
                const pct = c.totalRecipients ? (processed / c.totalRecipients) * 100 : 0;
                const canStart = c.status === "draft" || c.status === "send_complete";
                return (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer"
                    onClick={() => setDetailId(c.id)}
                  >
                    <TableCell>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {fmt(c.totalRecipients)} recipients · {c.provider}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(c.status)}>{statusLabel(c.status)}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="h-2 overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-primary to-emerald-400 transition-[width] duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                        {pct.toFixed(1)}%
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {relTime(c.createdAt)}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setDetailId(c.id)}>
                          <IconEye size={15} /> View
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canStart}
                          onClick={() => setStartTarget(c)}
                        >
                          <IconPlayerPlay size={15} /> Start
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <CreateCampaignDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          load();
          setDetailId(id);
        }}
      />

      <ConfirmDialog
        open={!!startTarget}
        onOpenChange={(o) => !o && setStartTarget(null)}
        title="Start campaign?"
        description={
          startTarget
            ? `This will begin sending to ${fmt(startTarget.totalRecipients)} recipients via ${startTarget.provider}.`
            : ""
        }
        confirmLabel="Start sending"
        onConfirm={() => {
          if (startTarget) void api.start(startTarget.id).then(load);
        }}
      />

      <CampaignDetailSheet
        id={detailId}
        onOpenChange={(o) => !o && setDetailId(null)}
        onChanged={load}
      />
    </div>
  );
}
