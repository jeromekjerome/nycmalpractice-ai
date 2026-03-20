// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { neon } from '@neondatabase/serverless';
import { answerUserQuestion } from './ask.js';
import { scoreLead, createAuction, deliverColdLead, getAuctionStatus, placeBid, acceptLead, declineLead, TIER_CONFIG } from './auction.js';
import { registerFirm, sendVerificationCode, verifyPhoneCode, validateToken, updateFirmSubscription, getFirm, updateFirmProfile, createMagicLink } from './firms.js';
import nodemailer from 'nodemailer';
import { createSubscriptionCheckout, createPortalSession, constructWebhookEvent } from './stripe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const sql = neon(process.env.DATABASE_URL);

app.use(cors());
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

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
    upsertConversation(sessionId, mode, result.caseType, updatedHistory).catch(console.error);

    if (result.leadScore) {
      const score    = result.leadScore;
      const leadData = { caseType: result.caseType, mode, question, history: updatedHistory, preview: score.preview, scoredAt: new Date().toISOString() };

      const alreadyProcessed = await sql`SELECT 1 FROM user_interactions WHERE session_id = ${sessionId} AND lead_email_sent = TRUE LIMIT 1`;
      if (alreadyProcessed.length === 0) {
        await sql`UPDATE user_interactions SET lead_email_sent = TRUE WHERE session_id = ${sessionId}`;
        if (score.tier === 'cold') {
          deliverColdLead(sessionId, result.caseType, score, leadData).catch(console.error);
        } else {
          createAuction(sessionId, result.caseType, score, leadData).catch(console.error);
        }
      }
    }

    res.json({ answer: result.answer, cases: result.cases || [], caseType: result.caseType || null, caseAnalysis: result.caseAnalysis || null, leadTier: result.leadScore?.tier || null });
  } catch (err) {
    console.error('Error in /api/ask:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Conversation History ─────────────────────────────────────────────────────
app.get('/api/conversations/:sessionId', async (req, res) => {
  try {
    const [conv] = await sql`SELECT session_id, mode, case_type, history, name, phone, updated_at FROM conversations WHERE session_id = ${req.params.sessionId} LIMIT 1`;
    if (!conv) return res.json({ history: [], name: null, phone: null });
    res.json(conv);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const url   = `${process.env.APP_URL || 'https://nycmalpractice.ai'}/portal.html?token=${token}`;
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
  const url   = `${process.env.APP_URL || 'https://nycmalpractice.ai'}/portal.html?token=${token}`;
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
async function upsertConversation(sessionId, mode, caseType, history) {
  const userText   = history.filter(h => h.role === 'user').map(h => h.content).join(' ');
  const phoneMatch = userText.match(/\b(\+?1?\s?[-.]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b/);
  const phone      = phoneMatch ? phoneMatch[0].replace(/[\s.-]/g, '') : null;
  const nameMatch  = userText.match(/my name is\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
  const name       = nameMatch ? nameMatch[1] : null;
  const timeMatch  = userText.match(/(?:best time(?:\s+to call)?(?:\s+is)?|call(?:\s+me)?(?:\s+at)?)\s+([a-z0-9: ]+(?:am|pm|morning|afternoon|evening|noon|midnight)?)/i);
  const bestTime   = timeMatch ? timeMatch[1].trim() : null;

  await sql`
    INSERT INTO conversations (session_id, mode, case_type, history, name, phone, best_time, updated_at)
    VALUES (${sessionId}, ${mode}, ${caseType}, ${JSON.stringify(history)}, ${name}, ${phone}, ${bestTime}, NOW())
    ON CONFLICT (session_id) DO UPDATE SET
      mode = EXCLUDED.mode, case_type = COALESCE(EXCLUDED.case_type, conversations.case_type),
      history = EXCLUDED.history, name = COALESCE(EXCLUDED.name, conversations.name),
      phone = COALESCE(EXCLUDED.phone, conversations.phone),
      best_time = COALESCE(EXCLUDED.best_time, conversations.best_time), updated_at = NOW()
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

// ─── Start ────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  import('./cron.js').then(({ startCronJobs }) => startCronJobs());
  const PORT = process.env.PORT || 3003;
  app.listen(PORT, () => console.log(`MalpracticeAI running on http://localhost:${PORT}`));
}

export default app;
