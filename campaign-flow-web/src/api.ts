import type { Campaign, CampaignListItem, CampaignView, EventRow } from "./types";

const BASE = (import.meta.env.VITE_API_URL as string) || "http://localhost:4000";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  base: BASE,
  listCampaigns: () => json<CampaignListItem[]>("/campaigns"),
  getCampaign: (id: string) => json<CampaignView>(`/campaigns/${id}`),
  getEvents: (id: string) => json<EventRow[]>(`/campaigns/${id}/events`),
  createCampaign: (body: {
    name: string;
    subject: string;
    bodyTemplate: string;
    provider?: string;
  }) => json<Campaign>("/campaigns", { method: "POST", body: JSON.stringify(body) }),
  generateRecipients: (id: string, count: number) =>
    json<{ ok: boolean }>(`/campaigns/${id}/recipients`, {
      method: "POST",
      body: JSON.stringify({ count }),
    }),
  start: (id: string) => json(`/campaigns/${id}/start`, { method: "POST" }),
  pause: (id: string) => json(`/campaigns/${id}/pause`, { method: "POST" }),
  resume: (id: string) => json(`/campaigns/${id}/resume`, { method: "POST" }),
  cancel: (id: string) => json(`/campaigns/${id}/cancel`, { method: "POST" }),
  retry: (id: string) => json<{ ok: boolean; requeued: number }>(`/campaigns/${id}/retry`, { method: "POST" }),
  stream: (id: string, onData: (v: CampaignView) => void): (() => void) => {
    const es = new EventSource(`${BASE}/campaigns/${id}/stream`);
    es.onmessage = (e) => {
      try {
        onData(JSON.parse(e.data) as CampaignView);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => es.close();
  },
};
