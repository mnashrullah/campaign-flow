export interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
}

const FOOTER = `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />
<p style="font-size:12px;color:#888">
  Campaign Flow Inc, 123 Demo Street.
  <a href="{{unsubscribeUrl}}">Unsubscribe</a>
</p>`;

export const TEMPLATES: Template[] = [
  {
    id: "promo",
    name: "Promotion",
    subject: "A special promotion, {{name}} 🎉",
    body: `<h1>Hi {{name}} 👋</h1>
<p>We've got a special promotion just for you — 30% off your next order.</p>
<p><a href="https://example.com/promo" style="background:#4f8cff;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">See the offer</a></p>
${FOOTER}`,
  },
  {
    id: "newsletter",
    name: "Newsletter",
    subject: "Your monthly update, {{name}}",
    body: `<h1>Hello {{name}},</h1>
<p>Here's what's new this month at Campaign Flow.</p>
<ul><li>Faster sending</li><li>Better deliverability</li><li>New dashboard</li></ul>
${FOOTER}`,
  },
  {
    id: "announcement",
    name: "Announcement",
    subject: "Big news, {{name}}!",
    body: `<h1>{{name}}, we've got news 🚀</h1>
<p>We just launched something we think you'll love.</p>
<p><a href="https://example.com/launch">Check it out</a></p>
${FOOTER}`,
  },
];
