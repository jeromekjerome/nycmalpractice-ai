// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The demo copy of the site (DEMO_MODE=1) runs on its own database of synthetic patients, families, firms and
// auctions (demo/seed.mjs). Nothing in it may reach a real person, so every email and text it would send is
// written to the demo outbox instead, shown at /demo/outbox, and a live Stripe key is refused (stripe.js).
// With DEMO_MODE unset, none of this runs.
import { neon } from '@neondatabase/serverless';

// Read on every call, so a test can switch it.
export const isDemo = () => process.env.DEMO_MODE === '1';

const sql = neon(process.env.DATABASE_URL);

let outboxReady = null;
function outboxTable() {
  outboxReady ||= sql`
    CREATE TABLE IF NOT EXISTS demo_outbox (
      id          BIGSERIAL PRIMARY KEY,
      channel     TEXT NOT NULL,          -- email | sms
      recipient   TEXT,
      subject     TEXT,
      body        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`.catch(err => { outboxReady = null; throw err; });
  return outboxReady;
}

export async function recordDemoMessage({ channel, to, subject = null, body = '' }) {
  await outboxTable();
  await sql`INSERT INTO demo_outbox (channel, recipient, subject, body)
            VALUES (${channel}, ${String(to ?? '')}, ${subject}, ${String(body ?? '')})`;
  console.log(`[DEMO OUTBOX] ${channel} → ${to}: ${subject || String(body ?? '').slice(0, 60)}`);
}

// Stands in for a nodemailer transport.
export const demoMailer = {
  async sendMail(message) {
    await recordDemoMessage({ channel: 'email', to: message.to, subject: message.subject, body: message.html || message.text || '' });
    return { messageId: 'demo-outbox' };
  },
};

// Stands in for the Twilio client.
export const demoTexter = {
  messages: {
    async create({ to, body }) {
      await recordDemoMessage({ channel: 'sms', to, body });
      return { sid: 'demo-outbox' };
    },
  },
};

const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export async function outboxMessages(limit = 100) {
  await outboxTable();
  return sql`SELECT id, channel, recipient, subject, body, created_at FROM demo_outbox ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
}

// The newest messages first. An email is shown as it would arrive, in a sandboxed frame with no scripts; its links
// (sign-in links, auction links) open in a new tab, so the demo can be followed from email to page.
export function outboxPage(messages) {
  const items = messages.map(message => {
    const when = new Date(message.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
    const head = `<div class="meta"><span class="channel">${message.channel === 'sms' ? 'Text' : 'Email'}</span> to <strong>${escapeHtml(message.recipient)}</strong> · ${escapeHtml(when)} ET</div>`;
    if (message.channel === 'sms') return `<article class="msg">${head}<p class="sms">${escapeHtml(message.body)}</p></article>`;
    const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"></head><body style="margin:12px;background:#fff;color:#222">${message.body || ''}</body></html>`;
    return `<article class="msg">${head}<h2>${escapeHtml(message.subject || '(no subject)')}</h2>
      <iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${escapeHtml(doc)}" title="${escapeHtml(message.subject || 'email')}"></iframe></article>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Demo outbox — NYCMalpractice.ai</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; background: #0f1416; color: #d8e0e3; margin: 0; padding: 1.5rem 1rem; }
    main { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 1.4rem; margin-bottom: 0.3rem; }
    .intro { color: #9aa8ad; font-size: 0.9rem; margin-bottom: 1.5rem; line-height: 1.5; }
    .msg { border: 1px solid #2a3438; border-radius: 10px; padding: 1rem; margin-bottom: 1rem; background: #151c1f; }
    .meta { font-size: 0.8rem; color: #9aa8ad; margin-bottom: 0.4rem; }
    .channel { display: inline-block; padding: 1px 8px; border-radius: 99px; background: #9e3a5a; color: #fff; font-size: 0.7rem; font-weight: 700; margin-right: 0.3rem; }
    h2 { font-size: 1rem; margin: 0.2rem 0 0.6rem; }
    iframe { width: 100%; height: 360px; border: 0; border-radius: 8px; background: #fff; }
    .sms { font-size: 0.95rem; background: #1d2629; padding: 0.6rem 0.8rem; border-radius: 8px; }
    .empty { color: #9aa8ad; }
    a { color: #e07a9c; }
  </style>
</head>
<body>
  <main>
    <h1>Demo outbox</h1>
    <p class="intro">This is the demo copy of NYCMalpractice.ai. Every patient, family, firm and charge in it is synthetic. The emails and texts it would have sent are kept here instead of being delivered. Newest first. <a href="/">Back to the site</a></p>
    ${items || '<p class="empty">Nothing has been sent yet.</p>'}
  </main>
</body>
</html>`;
}
