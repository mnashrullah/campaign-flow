import { pool } from "../db/client.js";
import { env } from "../config/env.js";
import { createCampaign } from "../services/campaigns.js";
import { generateRecipients } from "../services/recipients.js";

/**
 * Seed a demo campaign with N synthetic recipients.
 *
 * Usage: npm run seed -- [count] [campaignId]
 *   count       default 1_000_000
 *   campaignId  seed into an existing campaign; otherwise a new one is created
 */
const DEFAULT_TEMPLATE = `<!doctype html>
<html><body style="font-family:sans-serif">
  <h1>Hi {{name}} 👋</h1>
  <p>We've got a special promotion just for you.</p>
  <p><a href="https://example.com/promo">See the offer</a></p>
  <hr>
  <p style="font-size:12px;color:#888">
    Campaign Flow Inc, 123 Demo Street.
    <a href="{{unsubscribeUrl}}">Unsubscribe</a>
  </p>
</body></html>`;

async function seed() {
  const count = Number(process.argv[2] ?? 1_000_000);
  let campaignId = process.argv[3];

  if (!campaignId) {
    const c = await createCampaign({
      name: `Demo campaign (${count.toLocaleString()} recipients)`,
      subject: "A special promotion, {{name}} 🎉",
      bodyTemplate: DEFAULT_TEMPLATE,
      fromEmail: env.FROM_EMAIL,
      provider: env.PROVIDER,
    });
    campaignId = c.id;
    console.log(`[seed] created campaign ${campaignId}`);
  }

  const started = Date.now();
  await generateRecipients(campaignId, count, (done) =>
    console.log(`[seed] ${done.toLocaleString()} / ${count.toLocaleString()}`),
  );

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[seed] done: ${count.toLocaleString()} recipients in ${secs}s`);
  console.log(`[seed] campaign id: ${campaignId}`);
}

seed()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
