import { env } from "../config/env.js";

// Pragmatic RFC-5322-ish check. Real MX validation is out of scope, but syntax
// validation is what keeps garbage addresses from inflating our bounce rate.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a personalization value so a recipient's name can't inject markup. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export interface RenderVars {
  name: string;
  email: string;
  unsubscribeUrl: string;
}

/**
 * Render a `{{var}}` template. All interpolated values are HTML-escaped. Unknown
 * placeholders are left blank rather than leaking `{{...}}` into the email.
 */
export function renderTemplate(template: string, vars: RenderVars): string {
  const dict = vars as unknown as Record<string, string>;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = dict[key];
    return v == null ? "" : escapeHtml(v);
  });
}

export function unsubscribeUrl(campaignId: string, email: string): string {
  const token = Buffer.from(`${campaignId}:${email}`).toString("base64url");
  return `${env.UNSUBSCRIBE_BASE_URL}?t=${token}`;
}

export function decodeUnsubscribeToken(token: string): { campaignId: string; email: string } | null {
  try {
    const [campaignId, email] = Buffer.from(token, "base64url").toString("utf8").split(":");
    if (!campaignId || !email) return null;
    return { campaignId, email };
  } catch {
    return null;
  }
}
