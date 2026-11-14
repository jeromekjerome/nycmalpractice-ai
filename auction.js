// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';
import nodemailer from 'nodemailer';
import { getActiveFirms, createMagicLink, getFirm, recordDecline, recentDeclineCounts } from './firms.js';
import { chargeCustomer, createRefund } from './stripe.js';
import { buildModelList, chatCompletionsWithFallback } from './openaiModelFailover.js';
import { APP_URL } from './site.js';

const sql    = neon(process.env.DATABASE_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const AUX_MODELS = buildModelList(
  process.env.OPENAI_MODEL_AUX || 'gpt-4o-mini',
  process.env.OPENAI_MODEL_AUX_FALLBACKS || 'gpt-5.4-mini,gpt-4.1'
);

export const TIER_CONFIG = {
  cold:    { label: 'Cold',    minScore: 55, maxScore: 69, reserve: 25,  auctionHours: 0, color: '#6b7a94' },
  warm:    { label: 'Warm',    minScore: 70, maxScore: 79, reserve: 100, auctionHours: 2, color: '#9e3a5a' },
  hot:     { label: 'Hot',     minScore: 80, maxScore: 89, reserve: 200, auctionHours: 4, color: '#7a2040' },
  premium: { label: 'Premium', minScore: 90, maxScore: 100, reserve: 400, auctionHours: 6, color: '#c93a6a' },
};

export function getTier(score) {
  if (score >= 90) return 'premium';
  if (score >= 80) return 'hot';
  if (score >= 70) return 'warm';
  return 'cold';
}

export async function scoreLead(question, history, caseType, mode) {
  try {
    const histText = history.map(h => `${h.role}: ${h.content}`).join('\n');

    const res = await chatCompletionsWithFallback(openai, {
      models: AUX_MODELS,
      messages: [{
        role: 'user',
        content: `You are a NYC medical malpractice case evaluator for a law firm lead marketplace.
The user is ${mode === 'estate' ? 'a family member / estate representative for a wrongful death claim' : 'a patient who was personally harmed'}.
Case type: ${caseType}

Score each dimension 1–10, then compute a weighted composite score 0–100.
Weights: injury_severity 30%, causation_clarity 25%, sol_status 20%, expert_viability 15%, damages_magnitude 10%

Conversation:
${histText}
Latest: ${question}

Respond ONLY with valid JSON:
{
  "viable": true/false,
  "score": 0-100,
  "dimensions": {
    "injury_severity":    1-10,
    "causation_clarity":  1-10,
    "sol_status":         1-10,
    "expert_viability":   1-10,
    "damages_magnitude":  1-10
  },
  "preview": "1-2 sentence factual summary with NO client PII — claim type, injury, approximate timeline only",
  "confidence": 0.0-1.0
}

A viable lead requires score >= 55 AND confidence >= 0.65.
sol_status: score 10 if well within SOL, lower if approaching deadline, 1-2 if likely expired.
Malpractice SOL in NY: 2.5 years from act/omission or the end of continuous treatment (personal); 2 years from death (wrongful death). A missed cancer diagnosis runs from discovery (Lavern's Law, 7-year outer limit); a foreign object allows 1 year from discovery. Public hospitals: 90-day notice of claim and 1 year and 90 days to sue.`,
      }],
      response_format: { type: 'json_object' },
      max_tokens: 300,
    });

    const result = JSON.parse(res.choices[0].message.content);
    if (!result.viable || result.confidence < 0.65 || result.score < 55) return null;
    const tier = getTier(result.score);
    return { ...result, tier, reserve: TIER_CONFIG[tier].reserve };
  } catch (err) {
    console.error('scoreLead error:', err.message);
    return null;
  }
}

export async function deliverColdLead(sessionId, caseType, scoreData, leadData) {
  const firms = await getActiveFirms(caseType);
  if (firms.length === 0) {
    await sendAdminLeadAlert('cold', caseType, scoreData, leadData);
    return;
  }
  for (const firm of firms) {
    try {
      let chargeId = null;
      if (firm.stripe_customer_id && firm.stripe_payment_method_id) {
        const charge = await chargeCustomer({
          stripeCustomerId: firm.stripe_customer_id, paymentMethodId: firm.stripe_payment_method_id,
          amountDollars: TIER_CONFIG.cold.reserve, description: `Cold malpractice lead — ${caseType}`,
          metadata: { sessionId, firmId: String(firm.id) },
        });
        chargeId = charge.id;
      }
      const deadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const [lead] = await sql`
        INSERT INTO leads (firm_id, session_id, case_type, tier, price_paid, stripe_charge_id, accept_deadline, lead_data)
        VALUES (${firm.id}, ${sessionId}, ${caseType}, 'cold', ${TIER_CONFIG.cold.reserve}, ${chargeId}, ${deadline}, ${JSON.stringify(leadData)})
        RETURNING id
      `;
      const token = await createMagicLink(firm.id, { leadId: lead.id, expiresInHours: 72 });
      await sendLeadDeliveryEmail(firm, lead.id, token, leadData, scoreData, 'cold');
    } catch (err) { console.error(`Cold lead delivery failed for firm ${firm.id}:`, err.message); }
  }
}

export async function createAuction(sessionId, caseType, scoreData, leadData) {
  const config   = TIER_CONFIG[scoreData.tier];
  const closesAt = new Date(Date.now() + config.auctionHours * 60 * 60 * 1000);
  const [auction] = await sql`
    INSERT INTO auctions (session_id, case_type, quality_score, tier, reserve_price, current_bid, closes_at, score_dimensions, lead_preview, lead_data)
    VALUES (${sessionId}, ${caseType}, ${scoreData.score}, ${scoreData.tier}, ${config.reserve}, ${config.reserve}, ${closesAt}, ${JSON.stringify(scoreData.dimensions)}, ${scoreData.preview}, ${JSON.stringify(leadData)})
    RETURNING *
  `;
  await notifyAllFirms(auction);
  return auction;
}

async function sendAdminLeadAlert(type, caseType, scoreData, leadData) {
  const adminEmail = process.env.NOTIFICATION_EMAIL;
  if (!adminEmail) return;
  const t = getTransporter();
  const html = `
    <div style="font-family:sans-serif;max-width:640px;margin:auto">
      <h2 style="color:#9e3a5a">⚠️ New Malpractice Lead — No Active Firms</h2>
      <p>A qualified lead came in but there are <strong>no subscribed firms</strong> to receive it.</p>
      <table style="width:100%;border-collapse:collapse;margin:1rem 0">
        <tr><td style="color:#666;padding:6px 0">Case Type</td><td>${caseType}</td></tr>
        <tr><td style="color:#666;padding:6px 0">Quality Score</td><td>${scoreData.score || '—'}/100</td></tr>
        <tr><td style="color:#666;padding:6px 0">Tier</td><td>${scoreData.tier || type}</td></tr>
      </table>
      <p><strong>Preview:</strong><br>${scoreData.preview || ''}</p>
    </div>
  `;
  if (!t) { console.log(`[EMAIL MOCK] Admin alert → ${adminEmail}`); return; }
  await t.sendMail({ from: process.env.SMTP_USER, to: adminEmail, subject: `⚠️ Malpractice Lead Dropped — No Active Firms (${scoreData.tier} / ${caseType})`, html }).catch(console.error);
}

// A visitor asked to be contacted, but their conversation never produced a qualifying lead score, so
// nothing went to firms. The operator is told, without the visitor's details (they are saved with the
// conversation), so someone can decide whether to follow up.
export async function notifyOperatorOfContactRequest(caseType, mode) {
  const adminEmail = process.env.NOTIFICATION_EMAIL;
  if (!adminEmail) return;
  const t = getTransporter();
  const who = mode === 'estate' ? 'family / estate' : 'injured patient';
  const html = `<div style="font-family:sans-serif;max-width:640px;margin:auto"><h2 style="color:#9e3a5a">Consultation request: not a qualified lead</h2><p>A visitor asked to be contacted and agreed to be contacted, but the conversation did not score as a qualified lead, so it was not sent to any firm.</p><p>Case type: ${caseType || 'unknown'} · ${who}</p><p>The contact details are saved with the conversation.</p></div>`;
  if (!t) { console.log(`[EMAIL MOCK] Contact request notice → ${adminEmail}`); return; }
  await t.sendMail({ from: process.env.SMTP_USER, to: adminEmail, subject: 'Consultation request: not a qualified lead', html }).catch(console.error);
}

export async function placeBid(auctionId, firmId, amount) {
  const [auction] = await sql`SELECT * FROM auctions WHERE id = ${auctionId} LIMIT 1`;
  if (!auction) return { ok: false, error: 'Auction not found' };
  if (auction.status !== 'open') return { ok: false, error: 'Auction is closed' };
  if (new Date(auction.closes_at) < new Date()) return { ok: false, error: 'Auction has expired' };
  const minBid = parseFloat(auction.current_bid) + 1;
  if (amount < minBid) return { ok: false, error: `Minimum bid is $${minBid.toFixed(2)}` };
  await sql`INSERT INTO bids (auction_id, firm_id, amount) VALUES (${auctionId}, ${firmId}, ${amount})`;
  await sql`UPDATE auctions SET current_bid = ${amount}, current_leader_id = ${firmId} WHERE id = ${auctionId}`;
  return { ok: true, currentBid: amount };
}

export async function getAuctionStatus(auctionId) {
  const [auction] = await sql`SELECT a.*, f.name as leader_name FROM auctions a LEFT JOIN firms f ON f.id = a.current_leader_id WHERE a.id = ${auctionId}`;
  if (!auction) return null;
  const bids     = await sql`SELECT amount, created_at FROM bids WHERE auction_id = ${auctionId} ORDER BY created_at DESC LIMIT 20`;
  const secsLeft = Math.max(0, Math.floor((new Date(auction.closes_at) - new Date()) / 1000));
  return {
    id: auction.id, tier: auction.tier, qualityScore: auction.quality_score,
    dimensions: auction.score_dimensions, preview: auction.lead_preview,
    caseType: auction.case_type, reservePrice: parseFloat(auction.reserve_price),
    currentBid: parseFloat(auction.current_bid), isLeading: false,
    status: auction.status, closesAt: auction.closes_at, secsLeft,
    bidCount: bids.length, recentBids: bids.map(b => ({ amount: parseFloat(b.amount), time: b.created_at })),
    config: TIER_CONFIG[auction.tier],
  };
}

export async function closeAuction(auctionId) {
  const [auction] = await sql`SELECT * FROM auctions WHERE id = ${auctionId} AND status = 'open' LIMIT 1`;
  if (!auction) return;
  if (!auction.current_leader_id) { await sql`UPDATE auctions SET status = 'cancelled' WHERE id = ${auctionId}`; return; }

  const winner = await getFirm(auction.current_leader_id);
  const winBid = parseFloat(auction.current_bid);
  let chargeId = null;
  try {
    if (winner.stripe_customer_id && winner.stripe_payment_method_id) {
      const charge = await chargeCustomer({ stripeCustomerId: winner.stripe_customer_id, paymentMethodId: winner.stripe_payment_method_id, amountDollars: winBid, description: `Malpractice lead auction — ${auction.tier} / ${auction.case_type}`, metadata: { auctionId: String(auctionId), firmId: String(winner.id) } });
      chargeId = charge.id;
    }
  } catch (err) { console.error(`Charge failed for auction ${auctionId}:`, err.message); }

  await sql`UPDATE auctions SET status = 'closed', winner_firm_id = ${winner.id}, winning_bid = ${winBid} WHERE id = ${auctionId}`;
  const deadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const [lead] = await sql`INSERT INTO leads (auction_id, firm_id, session_id, case_type, tier, price_paid, stripe_charge_id, accept_deadline) VALUES (${auctionId}, ${winner.id}, ${auction.session_id}, ${auction.case_type}, ${auction.tier}, ${winBid}, ${chargeId}, ${deadline}) RETURNING id`;
  const token = await createMagicLink(winner.id, { leadId: lead.id, expiresInHours: 72 });
  await sendLeadDeliveryEmail(winner, lead.id, token, auction.lead_data, auction, auction.tier);
  const losers = await sql`SELECT DISTINCT f.* FROM bids b JOIN firms f ON f.id = b.firm_id WHERE b.auction_id = ${auctionId} AND b.firm_id != ${winner.id}`;
  for (const loser of losers) await sendLoserEmail(loser, auction, winBid);
}

export async function acceptLead(leadId, firmId) {
  const [lead] = await sql`SELECT * FROM leads WHERE id = ${leadId} AND firm_id = ${firmId} LIMIT 1`;
  if (!lead) return { ok: false, error: 'Lead not found' };
  if (lead.status !== 'pending') return { ok: false, error: `Lead already ${lead.status}` };
  const [claimed] = await sql`UPDATE leads SET status = 'accepted' WHERE id = ${leadId} AND status = 'pending' RETURNING id`;
  if (!claimed) return { ok: false, error: 'Lead already answered' };
  return { ok: true };
}

// Terms: a lead not accepted or declined within 3 days is declined automatically, counts as a decline
// and is not refunded. One UPDATE claims every overdue lead, so a firm's answer arriving at the same
// moment is kept rather than overwritten.
export async function declineOverdueLeads() {
  const overdue = await sql`
    UPDATE leads SET status = 'declined', declined_at = NOW()
    WHERE status = 'pending' AND accept_deadline < NOW()
    RETURNING id, firm_id, auction_id`;
  for (const lead of overdue) await recordDecline(lead.firm_id, !!lead.auction_id);
  return overdue.length;
}

export async function declineLead(leadId, firmId) {
  const [lead] = await sql`SELECT * FROM leads WHERE id = ${leadId} AND firm_id = ${firmId} LIMIT 1`;
  if (!lead) return { ok: false, error: 'Lead not found' };
  if (lead.status !== 'pending') return { ok: false, error: `Lead already ${lead.status}` };
  const isAuction    = !!lead.auction_id;
  // Earlier declines in the last 30 days decide the refund for this one.
  const recent       = await recentDeclineCounts(firmId);
  const coldCount    = recent.cold + 1;
  const auctionCount = recent.auction + 1;
  // Claim the lead before any refund, so two decline clicks, or a decline racing an accept, refund at most once.
  const [claimed] = await sql`UPDATE leads SET status = 'declined', declined_at = NOW() WHERE id = ${leadId} AND status = 'pending' RETURNING id`;
  if (!claimed) return { ok: false, error: 'Lead already answered' };
  const pricePaid    = parseFloat(lead.price_paid);
  const refundAmount = isAuction
    ? (auctionCount === 1 ? pricePaid * 0.5 : auctionCount === 2 ? pricePaid * 0.25 : 0)
    : (coldCount <= 3 ? pricePaid : pricePaid * 0.5);
  // A refund is due only on a lead that was paid for, and is recorded only once Stripe has issued it. A
  // failed refund used to be recorded as paid; the operator is now told, so it can be issued by hand.
  const due = lead.stripe_charge_id ? refundAmount : 0;
  let refunded = 0;
  let stripeRefundId = null;
  let refundPending = 0;
  if (due > 0) {
    try {
      const refund = await createRefund({ paymentIntentId: lead.stripe_charge_id, amountDollars: due, idempotencyKey: `refund-lead-${leadId}` });
      stripeRefundId = refund.id;
      refunded = due;
    } catch (err) {
      console.error(`Refund for lead ${leadId} failed:`, err.message);
      refundPending = due;
      await notifyOperator(`Refund failed for lead #${leadId}`,
        `<p>A refund of $${due.toFixed(2)} for lead #${leadId} (firm ${escapeHtml(firmId)}) could not be issued automatically: ${escapeHtml(err.message)}</p>` +
        `<p>Issue it in Stripe against payment ${escapeHtml(lead.stripe_charge_id)}.</p>`);
    }
  }
  await sql`UPDATE leads SET refund_amount = ${refunded}, stripe_refund_id = ${stripeRefundId} WHERE id = ${leadId}`;
  await recordDecline(firmId, isAuction);
  return { ok: true, refundAmount: refunded, ...(refundPending ? { refundPending } : {}) };
}

// Emails the operator (NOTIFICATION_EMAIL). Never throws: a notice that cannot be sent is logged.
export async function notifyOperator(subject, html) {
  const adminEmail = process.env.NOTIFICATION_EMAIL;
  if (!adminEmail) { console.warn(`[operator notice, NOTIFICATION_EMAIL not set] ${subject}`); return; }
  const t = getTransporter();
  if (!t) { console.log(`[EMAIL MOCK] Operator notice: ${subject} → ${adminEmail}`); return; }
  await t.sendMail({ from: process.env.SMTP_USER, to: adminEmail, subject, html }).catch(err => console.error('Operator notice failed:', err.message));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getTransporter() {
  if (!process.env.SMTP_USER) return null;
  return nodemailer.createTransport({ host: process.env.SMTP_HOST || 'mail.jwd.nyc', port: 465, secure: true, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
}

async function sendLeadDeliveryEmail(firm, leadId, token, leadData, scoreData, tier) {
  const url        = `${APP_URL}/lead.html?id=${leadId}&token=${token}`;
  const tierConfig = TIER_CONFIG[tier] || TIER_CONFIG.cold;
  const data       = typeof leadData === 'string' ? JSON.parse(leadData) : leadData;
  const t          = getTransporter();
  const html = `<div style="font-family:sans-serif;max-width:640px;margin:auto"><h2 style="color:#9e3a5a">✅ New Malpractice Lead — ${tierConfig.label}</h2><p>You have <strong>3 days</strong> to accept or decline.</p><p><strong>Preview:</strong><br>${scoreData.lead_preview || scoreData.preview || ''}</p><p><a href="${url}" style="background:#9e3a5a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View Lead →</a></p></div>`;
  if (!t) { console.log(`[EMAIL MOCK] Lead delivery → ${firm.email}`); return; }
  await t.sendMail({ from: process.env.SMTP_USER, to: firm.email, subject: `✅ New Malpractice Lead: ${tierConfig.label} — ${data?.caseType || 'Medical Malpractice'}`, html });
}

async function notifyAllFirms(auction) {
  const firms  = await getActiveFirms(auction.case_type);
  if (firms.length === 0) { await sendAdminLeadAlert('auction', auction.case_type, auction, auction.lead_data); return; }
  const config = TIER_CONFIG[auction.tier];
  const t      = getTransporter();
  for (const firm of firms) {
    try {
      const token    = await createMagicLink(firm.id, { auctionId: auction.id, expiresInHours: config.auctionHours + 1 });
      const url      = `${APP_URL}/auction.html?id=${auction.id}&token=${token}`;
      const closesAt = new Date(auction.closes_at).toLocaleString('en-US', { timeZone: 'America/New_York' });
      const html = `<div style="font-family:sans-serif;max-width:640px;margin:auto"><h2 style="color:#9e3a5a">🔔 New Malpractice Lead Auction — ${config.label}</h2><p><strong>Preview:</strong><br>${auction.lead_preview}</p><p>Reserve: $${config.reserve} · Closes: ${closesAt} ET</p><p><a href="${url}" style="background:#9e3a5a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Bid →</a></p></div>`;
      if (t) { await t.sendMail({ from: process.env.SMTP_USER, to: firm.email, subject: `🔔 Malpractice Lead Auction: ${config.label} — Closes in ${config.auctionHours}h`, html }); }
      else { console.log(`[EMAIL MOCK] Auction ${auction.id} → ${firm.email}`); }
    } catch (err) { console.error(`Notification failed for firm ${firm.id}:`, err.message); }
  }
}

async function sendLoserEmail(firm, auction, winningBid) {
  const t = getTransporter();
  const msg = `Auction #${auction.id} closed. Winning bid: $${winningBid.toFixed(2)}. You were not charged.`;
  if (!t) { console.log(`[EMAIL MOCK] Loser → ${firm.email}`); return; }
  await t.sendMail({ from: process.env.SMTP_USER, to: firm.email, subject: 'Auction Closed — Lead Went to Another Firm', html: `<p style="font-family:sans-serif">${msg}</p>` });
}
