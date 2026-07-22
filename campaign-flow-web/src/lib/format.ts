import type { CampaignStatus } from "@/types";

export const fmt = (n: number) => n.toLocaleString();

export function fmtDuration(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return "—";
  if (secs < 60) return `${Math.ceil(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function relTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export type BadgeVariant = "default" | "success" | "warning" | "danger" | "info" | "muted";

export function statusVariant(status: CampaignStatus): BadgeVariant {
  switch (status) {
    case "running":
      return "success";
    case "paused":
      return "warning";
    case "send_complete":
    case "settled":
      return "info";
    case "cancelled":
      return "danger";
    default:
      return "muted";
  }
}

export const statusLabel = (s: CampaignStatus) => s.replace("_", " ");
