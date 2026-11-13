// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { neon } from '@neondatabase/serverless';
import { answerUserQuestion } from './ask.js';
import { createAuction, deliverColdLead, getAuctionStatus, placeBid, acceptLead, declineLead, notifyOperatorOfContactRequest, TIER_CONFIG } from './auction.js';
import { registerFirm, sendVerificationCode, verifyPhoneCode, validateToken, updateFirmSubscription, getFirm, updateFirmProfile, createMagicLink } from './firms.js';
import nodemailer from 'nodemailer';
import { createSubscriptionCheckout, createPortalSession, constructWebhookEvent } from './stripe.js';
import OpenAI from 'openai';
import { buildModelList, probeAllModelChains } from './openaiModelFailover.js';
import { APP_URL, CONTACT_CONSENT_TEXT, CONTACT_FORM_FROM_STEP } from './site.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const sql = neon(process.env.DATABASE_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const answerModels = buildModelList(
  process.env.OPENAI_MODEL_ANSWER || 'gpt-4o',
  process.env.OPENAI_MODEL_ANSWER_FALLBACKS || 'gpt-5.4-mini,gpt-4.1'
);
const auxModels = buildModelList(
  process.env.OPENAI_MODEL_AUX || 'gpt-4o-mini',
  process.env.OPENAI_MODEL_AUX_FALLBACKS || 'gpt-5.4-mini,gpt-4.1'
);
const embeddingModels = buildModelList(
  process.env.OPENAI_MODEL_EMBEDDING || 'text-embedding-3-small',
  process.env.OPENAI_MODEL_EMBEDDING_FALLBACKS || 'text-embedding-3-large'
);
let modelHealthSnapshot = {
  answer: { active: answerModels[0] || null, fallbacks_available: answerModels.slice(1) },
  aux: { active: auxModels[0] || null, fallbacks_available: auxModels.slice(1) },
  embedding: { active: embeddingModels[0] || null, fallbacks_available: embeddingModels.slice(1) },
};
const MODEL_HEALTH_TTL_MS = Number.parseInt(process.env.MODEL_HEALTH_TTL_MS || '60000', 10);
let modelHealthLastCheckedAt = 0;
let modelHealthRefreshPromise = null;

app.use(cors());
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ─── Work a reply must not leave behind ───────────────────────────────────────
// A serverless function is suspended as soon as its response is sent, so work still running at
// that point is lost: on Vercel the conversation was never saved, and a lead hand-off started the
// same way would stop part-way. This work is therefore finished before the reply goes out.
// One time budget per reply covers all of it, so a slow mail server or payment call cannot hold
// the reply: work that outlasts the budget is logged, because on a serverless host it may not
// complete.
const DEFAULT_FOLLOW_UP_WORK_CAP_MS = 20_000;

function followUpDeadline() {
  return Date.now() + (Number(process.env.ASK_FOLLOW_UP_WORK_CAP_MS) || DEFAULT_FOLLOW_UP_WORK_CAP_MS);
}

async function finishBeforeReply(label, work, deadline) {
  // The failure handler is attached at once, so a rejection after the deadline is never unhandled.
  const settled = Promise.resolve(work).then(
    () => 'done',
    (err) => { console.error(`[ask] ${label} failed:`, err?.message || err); return 'failed'; },
  );
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), 'timed out'); });
  const outcome = await Promise.race([settled, timedOut]);
  clearTimeout(timer);
  if (outcome === 'timed out') {
    console.error(`[ask] ${label} was still running when the reply was due; replying without waiting for it`);
  }
  return outcome;
}

// ─── AI Chat ──────────────────────────────────────────────────────────────────
app.post('/api/ask', async (req, res) => {
  const { question, mode = 'personal', sessionId, history = [] } = req.body;
  if (!question?.trim() || !sessionId) return res.status(400).json({ error: 'question and sessionId required' });

  try {
    const result = await answerUserQuestion({ question, mode, sessionId, history });

    try {
      await sql`INSERT INTO user_interactions (session_id, question, mode, case_type) VALUES (${sessionId}, ${question}, ${mode}, ${result.caseType || 'other'})`;
    } catch (dbErr) { console.warn('DB log failed:', dbErr.message); }

    const updatedHistory = [...history, { role: 'user', content: question }, { role: 'assistant', content: result.answer }];
    // A qualifying lead score is kept with the conversation. The lead goes to firms only from
    // /api/contact, once the visitor has given contact details and agreed to be contacted.
    const leadScore = result.leadScore ? { ...result.leadScore, scoredAt: new Date().toISOString() } : null;
    await finishBeforeReply('saving the conversation', upsertConversation(sessionId, mode, result.caseType, updatedHistory, leadScore), followUpDeadline());

    res.json({
      answer: result.answer, cases: result.cases || [], caseType: result.caseType || null,
      caseAnalysis: result.caseAnalysis || null, leadTier: result.leadScore?.tier || null,
      // From the referral step on, the page offers the contact form.
      contactForm: result.turn >= CONTACT_FORM_FROM_STEP,
    });
  } catch (err) {
    console.error('Error in /api/ask:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Conversation History ─────────────────────────────────────────────────────
app.get('/api/conversations/:sessionId', async (req, res) => {
  try {
    const [conv] = await sql`SELECT session_id, mode, case_type, history, name, phone, contact_consent_at, updated_at FROM conversations WHERE session_id = ${req.params.sessionId} LIMIT 1`;
    if (!conv) return res.json({ history: [], name: null, phone: null });
    res.json(conv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Contact request ──────────────────────────────────────────────────────────
// A lead goes to law firms only from here: once the visitor has given a name and phone number in the
// contact form and agreed to the consent text. The lead carries those details, so the firm that takes
// it can reach the visitor.
app.post('/api/contact', async (req, res) => {
  const { sessionId, name, phone, bestTime, consent } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  const digits    = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  const cleanTime = typeof bestTime === 'string' ? bestTime.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
  if (typeof sessionId !== 'string' || !sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (cleanName.length < 2 || cleanName.length > 100) return res.status(400).json({ error: 'Please enter your name.' });
  if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) return res.status(400).json({ error: 'Please enter a 10-digit phone number.' });
  if (consent !== true) return res.status(400).json({ error: 'Please check the box to agree to be contacted.' });

  try {
    const [conv] = await sql`SELECT mode, case_type, history, lead_score FROM conversations WHERE session_id = ${sessionId} LIMIT 1`;
    if (!conv) return res.status(404).json({ error: 'We could not find your conversation. Please send a message first.' });

    const phoneNumber = digits.slice(-10);
    const [saved] = await sql`
      UPDATE conversations
      SET name = ${cleanName}, phone = ${phoneNumber}, best_time = ${cleanTime || null},
          contact_consent_at = NOW(), contact_consent_text = ${CONTACT_CONSENT_TEXT}, updated_at = NOW()
      WHERE session_id = ${sessionId}
      RETURNING contact_consent_at`;

    const score = conv.lead_score;
    if (score?.tier) {
      // Once per session, as before.
      const alreadyProcessed = await sql`SELECT 1 FROM user_interactions WHERE session_id = ${sessionId} AND lead_email_sent = TRUE LIMIT 1`;
      if (alreadyProcessed.length === 0) {
        await sql`UPDATE user_interactions SET lead_email_sent = TRUE WHERE session_id = ${sessionId}`;
        const leadData = {
          caseType: conv.case_type, mode: conv.mode, history: conv.history,
          preview: score.preview, score: score.score, dimensions: score.dimensions, scoredAt: score.scoredAt || null,
          contact: { name: cleanName, phone: phoneNumber, bestTime: cleanTime || null, consentedAt: saved?.contact_consent_at || null },
        };
        const handOff = score.tier === 'cold'
          ? deliverColdLead(sessionId, conv.case_type, score, leadData)
          : createAuction(sessionId, conv.case_type, score, leadData);
        await finishBeforeReply('lead hand-off', handOff, followUpDeadline());
      }
    } else {
      await finishBeforeReply('contact request notice', notifyOperatorOfContactRequest(conv.case_type, conv.mode), followUpDeadline());
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /api/contact:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Firm Registration ────────────────────────────────────────────────────────
app.post('/api/firms/register', async (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !email || !phone) return res.status(400).json({ error: 'name, email, phone required' });
  try {
    const { firm, isNew } = await registerFirm({ name, email, phone });
    if (isNew) await sendVerificationCode(firm.id);
    res.json({ firmId: firm.id, isNew, phoneVerified: firm.phone_verified });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/firms/verify-phone', async (req, res) => {
  const { firmId, code } = req.body;
  if (!firmId || !code) return res.status(400).json({ error: 'firmId and code required' });
  res.json({ ok: await verifyPhoneCode(firmId, code) });
});

app.put('/api/firms/:id/profile', async (req, res) => {
  const { specializations, serviceArea, contactName } = req.body;
  try {
    await updateFirmProfile(req.params.id, { specializations: specializations || [], serviceArea, contactName });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/firms/resend-code', async (req, res) => {
  const { firmId } = req.body;
  if (!firmId) return res.status(400).json({ error: 'firmId required' });
  await sendVerificationCode(firmId);
  res.json({ ok: true });
});

// ─── Stripe ───────────────────────────────────────────────────────────────────
app.post('/api/billing/checkout', async (req, res) => {
  const { firmId } = req.body;
  if (!firmId) return res.status(400).json({ error: 'firmId required' });
  const firm = await getFirm(firmId);
  if (!firm) return res.status(404).json({ error: 'Firm not found' });
  if (!firm.phone_verified) return res.status(403).json({ error: 'Phone not verified' });
  try {
    const session = await createSubscriptionCheckout({ stripeCustomerId: firm.stripe_customer_id, firmId });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/billing/portal', async (req, res) => {
  const tokenData = await validateToken(req.query.token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid token' });
  try {
    const portal = await createPortalSession({ stripeCustomerId: tokenData.stripe_customer_id });
    res.redirect(portal.url);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/webhooks/stripe', async (req, res) => {
  let event;
  try { event = constructWebhookEvent(req.body, req.headers['stripe-signature']); }
  catch (err) { return res.status(400).send(`Webhook error: ${err.message}`); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const firmId  = session.metadata?.firmId || session.subscription_data?.metadata?.firmId;
    if (firmId && session.subscription) {
      try {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const sub    = await stripe.subscriptions.retrieve(session.subscription, { expand: ['default_payment_method'] });
        await updateFirmSubscription(firmId, { stripeSubscriptionId: session.subscription, stripePaymentMethodId: sub.default_payment_method?.id || null });
      } catch (err) { console.error('Subscription activation error:', err.message); }
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    await sql`UPDATE firms SET subscription_active = FALSE WHERE stripe_subscription_id = ${event.data.object.id}`;
  }
  res.json({ received: true });
});

// ─── Auctions ─────────────────────────────────────────────────────────────────
app.get('/api/auctions/:id', async (req, res) => {
  const tokenData = await validateToken(req.query.token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired link' });
  const status = await getAuctionStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'Auction not found' });
  const [myBid] = await sql`SELECT amount FROM bids WHERE auction_id = ${req.params.id} AND firm_id = ${tokenData.firm_id} ORDER BY amount DESC LIMIT 1`;
  status.isLeading  = status.currentBid === (myBid ? parseFloat(myBid.amount) : -1);
  status.myBid      = myBid ? parseFloat(myBid.amount) : null;
  status.firmName   = tokenData.name;
  status.tierConfig = TIER_CONFIG[status.tier];
  res.json(status);
});

app.post('/api/auctions/:id/bid', async (req, res) => {
  const { token, amount } = req.body;
  const tokenData = await validateToken(token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired link' });
  if (!tokenData.subscription_active) return res.status(403).json({ error: 'Active subscription required' });
  if (tokenData.suspended_until && new Date(tokenData.suspended_until) > new Date()) return res.status(403).json({ error: `Account suspended until ${new Date(tokenData.suspended_until).toLocaleDateString()}` });
  res.json(await placeBid(req.params.id, tokenData.firm_id, parseFloat(amount)));
});

// ─── Leads ────────────────────────────────────────────────────────────────────
app.get('/api/leads/:id', async (req, res) => {
  const tokenData = await validateToken(req.query.token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired link' });
  const [lead] = await sql`SELECT * FROM leads WHERE id = ${req.params.id} AND firm_id = ${tokenData.firm_id}`;
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  let fullData = null;
  if (lead.auction_id) {
    const [auction] = await sql`SELECT lead_data, lead_preview, quality_score, tier, score_dimensions FROM auctions WHERE id = ${lead.auction_id}`;
    fullData = { ...auction?.lead_data, preview: auction?.lead_preview, score: auction?.quality_score, tier: auction?.tier, dimensions: auction?.score_dimensions };
  } else if (lead.lead_data) {
    // A cold lead has no auction: the lead row keeps what the firm bought.
    fullData = { ...lead.lead_data, tier: lead.tier };
  }
  const daysLeft     = Math.max(0, Math.ceil((new Date(lead.accept_deadline) - new Date()) / (1000 * 60 * 60 * 24)));
  const coldCount    = (tokenData.cold_decline_count || 0) + 1;
  const auctionCount = (tokenData.auction_decline_count || 0) + 1;
  const isAuction    = !!lead.auction_id;
  const declinePolicy = isAuction
    ? (auctionCount === 1 ? { refundPct: 50, message: '50% refund' } : auctionCount === 2 ? { refundPct: 25, message: '25% refund' } : { refundPct: 0, message: 'No refund + 30-day suspension' })
    : (coldCount <= 3 ? { refundPct: 100, message: 'Full refund' } : { refundPct: 50, message: '50% refund' });
  res.json({ id: lead.id, status: lead.status, caseType: lead.case_type, tier: lead.tier, pricePaid: parseFloat(lead.price_paid), acceptDeadline: lead.accept_deadline, daysLeft, leadData: fullData, declinePolicy });
});

app.post('/api/leads/:id/accept', async (req, res) => {
  const tokenData = await validateToken(req.body.token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid token' });
  res.json(await acceptLead(req.params.id, tokenData.firm_id));
});

app.post('/api/leads/:id/decline', async (req, res) => {
  const tokenData = await validateToken(req.body.token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid token' });
  res.json(await declineLead(req.params.id, tokenData.firm_id));
});

// ─── Firm Portal ──────────────────────────────────────────────────────────────
app.post('/api/firms/portal-link', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const [firm] = await sql`SELECT id, name, email FROM firms WHERE email = ${email} LIMIT 1`;
    if (!firm) return res.status(404).json({ error: 'No firm found with that email address' });
    const token = await createMagicLink(firm.id, { expiresInHours: 720 });
    const url   = `${APP_URL}/portal.html?token=${token}`;
    await sendPortalLinkEmail(firm, url);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/portal', async (req, res) => {
  const tokenData = await validateToken(req.query.token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired link' });
  const firm  = await getFirm(tokenData.firm_id);
  const leads = await sql`SELECT id, case_type, tier, price_paid, status, created_at FROM leads WHERE firm_id = ${tokenData.firm_id} ORDER BY created_at DESC LIMIT 20`;
  res.json({ firm, leads });
});

app.put('/api/portal/profile', async (req, res) => {
  const { token, specializations, serviceArea, contactName } = req.body;
  const tokenData = await validateToken(token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired link' });
  await updateFirmProfile(tokenData.firm_id, { specializations: specializations || [], serviceArea, contactName });
  res.json({ ok: true });
});

// ─── Admin ────────────────────────────────────────────────────────────────────
function requireAdmin(req, res) {
  if (process.env.ADMIN_SECRET && req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Unauthorized' }); return false;
  }
  return true;
}

app.get('/api/admin/firms', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const firms      = await sql`SELECT * FROM firms ORDER BY created_at DESC`;
  const [counts]   = await sql`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE subscription_active) AS active, COUNT(*) FILTER (WHERE NOT active) AS inactive FROM firms`;
  const [leadCounts] = await sql`SELECT COUNT(*) AS total FROM leads`;
  res.json({ firms, counts, leadCounts });
});

app.patch('/api/admin/firms/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { active, specializations, serviceArea, contactName } = req.body;
  if (typeof active === 'boolean') await sql`UPDATE firms SET active = ${active} WHERE id = ${req.params.id}`;
  if (specializations !== undefined || serviceArea !== undefined || contactName !== undefined) await updateFirmProfile(req.params.id, { specializations: specializations || [], serviceArea, contactName });
  res.json({ ok: true });
});

app.post('/api/admin/firms/:id/send-link', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const firm = await getFirm(req.params.id);
  if (!firm) return res.status(404).json({ error: 'Firm not found' });
  const token = await createMagicLink(firm.id, { expiresInHours: 720 });
  const url   = `${APP_URL}/portal.html?token=${token}`;
  await sendPortalLinkEmail(firm, url);
  res.json({ ok: true, url });
});

// ─── Case Types ───────────────────────────────────────────────────────────────
app.get('/api/case-types', (_req, res) => {
  res.json({
    caseTypes: [
      'Surgical Error', 'Failure to Diagnose / Misdiagnosis', 'Medication Error',
      'Birth Injury', 'Anesthesia Error', 'Hospital Negligence',
      'Nursing Home Neglect', 'Dental Malpractice',
    ],
  });
});

app.post('/api/reset-session', async (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) { try { await sql`DELETE FROM conversations WHERE session_id = ${sessionId}`; } catch {} }
  res.json({ ok: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function upsertConversation(sessionId, mode, caseType, history, leadScore = null) {
  const userText   = history.filter(h => h.role === 'user').map(h => h.content).join(' ');
  const phoneMatch = userText.match(/\b(\+?1?\s?[-.]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b/);
  const phone      = phoneMatch ? phoneMatch[0].replace(/[\s.-]/g, '') : null;
  const nameMatch  = userText.match(/my name is\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
  const name       = nameMatch ? nameMatch[1] : null;
  const timeMatch  = userText.match(/(?:best time(?:\s+to call)?(?:\s+is)?|call(?:\s+me)?(?:\s+at)?)\s+([a-z0-9: ]+(?:am|pm|morning|afternoon|evening|noon|midnight)?)/i);
  const bestTime   = timeMatch ? timeMatch[1].trim() : null;

  await sql`
    INSERT INTO conversations (session_id, mode, case_type, history, name, phone, best_time, lead_score, updated_at)
    VALUES (${sessionId}, ${mode}, ${caseType}, ${JSON.stringify(history)}, ${name}, ${phone}, ${bestTime}, ${leadScore ? JSON.stringify(leadScore) : null}, NOW())
    ON CONFLICT (session_id) DO UPDATE SET
      mode = EXCLUDED.mode, case_type = COALESCE(EXCLUDED.case_type, conversations.case_type),
      history = EXCLUDED.history, name = COALESCE(EXCLUDED.name, conversations.name),
      phone = COALESCE(EXCLUDED.phone, conversations.phone),
      best_time = COALESCE(EXCLUDED.best_time, conversations.best_time),
      lead_score = COALESCE(EXCLUDED.lead_score, conversations.lead_score), updated_at = NOW()
  `;
}

function getTransporter() {
  if (!process.env.SMTP_USER) return null;
  return nodemailer.createTransport({ host: process.env.SMTP_HOST || 'mail.jwd.nyc', port: parseInt(process.env.SMTP_PORT || '465'), secure: true, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
}

async function sendPortalLinkEmail(firm, url) {
  const t    = getTransporter();
  const html = `<div style="font-family:sans-serif;max-width:580px;margin:auto"><h2 style="color:#9e3a5a">Your MalpracticeAI Firm Portal</h2><p>Hi ${firm.name},</p><p>Use the link below to access your firm portal.</p><p style="margin:1.5rem 0"><a href="${url}" style="background:#9e3a5a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Access Your Portal →</a></p><p style="color:#999;font-size:12px">Valid for 30 days. Do not share.</p></div>`;
  if (!t) { console.log(`[EMAIL MOCK] Portal link → ${firm.email}: ${url}`); return; }
  await t.sendMail({ from: process.env.SMTP_USER, to: firm.email, subject: 'Your MalpracticeAI Firm Portal Access Link', html });
}

// ─── Cron Endpoints ───────────────────────────────────────────────────────────
function verifyCron(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' }); return false;
  }
  return true;
}

// Combined nightly job — this is the path vercel.json actually schedules. Until it existed the
// scheduled call got a 404 and nothing ran: expired auctions stayed open and overdue leads pending.
// Runs close-auctions → overdue-leads → reset-declines → the 90-day conversation purge, in sequence.
app.get('/api/cron', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    const { closeAuction } = await import('./auction.js');
    const { recordDecline, resetDeclineCounts } = await import('./firms.js');

    const expired = await sql`SELECT id FROM auctions WHERE status = 'open' AND closes_at < NOW()`;
    for (const row of expired) await closeAuction(row.id);

    const overdue = await sql`SELECT id, firm_id, auction_id FROM leads WHERE status = 'pending' AND accept_deadline < NOW()`;
    for (const lead of overdue) {
      await sql`UPDATE leads SET status = 'declined' WHERE id = ${lead.id}`;
      await recordDecline(lead.firm_id, !!lead.auction_id);
    }

    await resetDeclineCounts();

    // Conversations past the privacy policy's 90 days are deleted (see retention.js).
    const { purgeExpiredConversations } = await import('./retention.js');
    const purged = await purgeExpiredConversations();
    res.json({ ok: true, closed: expired.length, declined: overdue.length, purged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cron/close-auctions', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    const { closeAuction } = await import('./auction.js');
    const expired = await sql`SELECT id FROM auctions WHERE status = 'open' AND closes_at < NOW()`;
    for (const row of expired) await closeAuction(row.id);
    res.json({ closed: expired.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cron/overdue-leads', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    const { recordDecline } = await import('./firms.js');
    const overdue = await sql`SELECT id, firm_id, auction_id FROM leads WHERE status = 'pending' AND accept_deadline < NOW()`;
    for (const lead of overdue) {
      await sql`UPDATE leads SET status = 'declined' WHERE id = ${lead.id}`;
      await recordDecline(lead.firm_id, !!lead.auction_id);
    }
    res.json({ declined: overdue.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'malpractice-ai' }));
app.get('/health/models', async (_req, res) => {
  await refreshModelHealthSnapshot();
  res.json(modelHealthSnapshot);
});

async function refreshModelHealthSnapshot({ force = false } = {}) {
  const now = Date.now();
  const isFresh = modelHealthLastCheckedAt && (now - modelHealthLastCheckedAt) < MODEL_HEALTH_TTL_MS;
  if (!force && isFresh) return modelHealthSnapshot;
  if (modelHealthRefreshPromise) return modelHealthRefreshPromise;

  modelHealthRefreshPromise = probeAllModelChains(openai, {
    answerModels,
    auxModels,
    embeddingModels,
  })
    .then((snapshot) => {
      modelHealthSnapshot = snapshot;
      modelHealthLastCheckedAt = Date.now();
      console.log('[Health] Model callable check:', JSON.stringify(modelHealthSnapshot));
      return modelHealthSnapshot;
    })
    .catch((err) => {
      console.error('[Health] Model probe refresh failed:', err.message);
      return modelHealthSnapshot;
    })
    .finally(() => {
      modelHealthRefreshPromise = null;
    });

  return modelHealthRefreshPromise;
}

// ─── Start ────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test' && (process.env.NODE_ENV !== 'production' || !process.env.VERCEL)) {
  import('./cron.js').then(({ startCronJobs }) => startCronJobs());
  const PORT = process.env.PORT || 3003;
  refreshModelHealthSnapshot({ force: true })
    .finally(() => {
      app.listen(PORT, () => console.log(`MalpracticeAI running on http://localhost:${PORT}`));
    });
}

export default app;
