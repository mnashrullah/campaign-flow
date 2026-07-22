export type CampaignStatus =
  | "draft"
  | "running"
  | "paused"
  | "send_complete"
  | "settled"
  | "cancelled";

export interface Counters {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  suppressed: number;
  delivered: number;
  bounced: number;
  complained: number;
  retried: number;
  dlq: number;
}

export type ProviderName = "dryrun" | "ses" | "resend";

export interface Campaign {
  id: string;
  name: string;
  subject: string;
  bodyTemplate: string;
  fromEmail: string;
  provider: string;
  status: CampaignStatus;
  totalRecipients: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CampaignView {
  campaign: Campaign;
  counters: Counters;
  rate: number;
  progress: number;
  processed: number;
  total: number;
}

export interface CampaignListItem extends Campaign {
  counters: Counters;
}

export interface EventRow {
  id: number;
  campaignId: string;
  recipientId: number | null;
  type: string;
  payload: unknown;
  createdAt: string;
}
