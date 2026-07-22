import { env } from "../config/env.js";
import { EmailProvider } from "./types.js";
import { DryRunProvider } from "./dryrun.js";
import { SesProvider } from "./ses.js";
import { ResendProvider } from "./resend.js";

export * from "./types.js";

const cache = new Map<string, EmailProvider>();

/**
 * Returns the provider by name (defaults to env.PROVIDER), cached per name so a
 * campaign created in "live" (ses/resend) mode sends through that provider while a
 * "dry-run" campaign uses the simulator — even within the same worker.
 */
export function getProvider(name: string = env.PROVIDER): EmailProvider {
  const key = name === "ses" || name === "resend" ? name : "dryrun";
  const existing = cache.get(key);
  if (existing) return existing;
  const provider: EmailProvider =
    key === "ses" ? new SesProvider() : key === "resend" ? new ResendProvider() : new DryRunProvider();
  cache.set(key, provider);
  return provider;
}
