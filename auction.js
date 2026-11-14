// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';
import nodemailer from 'nodemailer';
import { getActiveFirms, createMagicLink, getFirm, recordDecline, recentDeclineCounts, setFirmCard, claimCardDeclinedNotice, clearCardDeclined } from './firms.js';
import { chargeCustomer, createRefund, cardsOnFile } from './stripe.js';
import { buildModelList, chatCompletionsWithFallback } from './openaiModelFailover.js';
import { APP_URL, MAX_FIRMS_PER_LEAD, caseTypeLabel } from './site.js';
import { randomInt } from 'node:crypto';

const sql    = neon(process.env.DATABASE_URL);
// Each AI call is cut off after 30 seconds and retried once; it could wait 10 minutes.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 });
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

// Charges a firm for a lead. The result says what happened:
//   { status: 'charged', id }   the charge went through;
//   { status: 'declined', reason }  it certainly did not (no card on file, the card declined, the bank wants the
//                              cardholder present, which an off-session charge cannot ask, or Stripe refused
//                              the request); `reason` is fit to show the firm;
//   { status: 'unknown' }      Stripe could not say (a network failure or a Stripe-side error after its own
//                              retries). The charge may have gone through, so the caller must not treat it as a
//                              decline and charge someone else.
// A charge declined on the stored card is tried once on each other card Stripe holds for the firm: a firm that
// replaced its card under Manage Billing used to have every lead charged to the old one.
async function chargeFirm(firm, amountDollars, description, metadata, idempotencyKey) {
  if (!firm?.stripe_customer_id) {
    console.warn(`Firm ${firm?.id} has no Stripe customer; not charged for: ${description}`);
    return { status: 'declined', reason: 'There is no billing account on file for your firm.' };
  }
  const stored = firm.stripe_payment_method_id || null;
  const first = stored
    ? await chargeCard(firm, stored, amountDollars, description, metadata, idempotencyKey)
    : { status: 'declined', reason: 'There is no card on file for your firm.' };
  if (first.status === 'charged') { await clearCardDeclined(firm.id).catch(() => {}); return first; }
  if (first.status !== 'declined') return first;

  const others = (await cardsOnFile({ stripeCustomerId: firm.stripe_customer_id, stripeSubscriptionId: firm.stripe_subscription_id })
    .catch(err => { console.error(`The cards on file for firm ${firm.id} could not be read:`, err.message); return []; }))
    .filter(card => card !== stored);
  for (const card of others) {
    // Its own key: Stripe refuses a key reused with different details, and a second run repeats each attempt.
    const retry = await chargeCard(firm, card, amountDollars, description, metadata, `${idempotencyKey}-${card}`);
    if (retry.status === 'charged') {
      await setFirmCard(firm.id, card).catch(err => console.error(`Saving card ${card} for firm ${firm.id} failed:`, err.message));
      return retry;
    }
    if (retry.status === 'unknown') return retry;
  }
  return first;
}

async function chargeCard(firm, card, amountDollars, description, metadata, idempotencyKey) {
  try {
    const charge = await chargeCustomer({
      stripeCustomerId: firm.stripe_customer_id,
      paymentMethodId:  card,
      amountDollars, description, metadata, idempotencyKey,
    });
    if (charge?.status === 'succeeded' || charge?.status === 'processing') return { status: 'charged', id: charge.id };
    if (charge?.status === 'requires_action') return { status: 'declined', reason: 'Your bank asked to approve the charge in person, which an automatic lead charge cannot do.' };
    if (['requires_payment_method', 'canceled'].includes(charge?.status)) return { status: 'declined', reason: 'Your card was declined.' };
    console.error(`Charge to firm ${firm.id} ended in status ${charge?.status}: ${description}`);
    return { status: 'unknown' };
  } catch (err) {
    if (err?.type === 'StripeCardError') {
      console.warn(`Charge to firm ${firm.id} declined (${err.code || err.type}): ${description}`);
      // Stripe writes card-error messages for the cardholder ("Your card has expired.").
      return { status: 'declined', reason: err.message || 'Your card was declined.' };
    }
    if (err?.type === 'StripeInvalidRequestError') {
      console.warn(`Charge to firm ${firm.id} refused (${err.code || err.type}): ${description}`);
      return { status: 'declined', reason: 'The card on file can no longer be charged.' };
    }
    console.error(`Charge to firm ${firm.id} has an unknown outcome (${err?.type || err?.message}): ${description}`);
    return { status: 'unknown' };
  }
}

// A firm whose card was declined for a lead is told why, with a portal link to update its card, at most once a
// day; the operator is told too. Such a firm used to lose the lead silently, and a top bidder was even told it
// had not been charged because another firm had won. Never throws.
async function tellFirmChargeFailed(firm, { lost, reason }) {
  try {
    if (!(await claimCardDeclinedNotice(firm.id))) return false;
    const token = await createMagicLink(firm.id, { expiresInHours: 720 });
    const url = `${APP_URL}/portal.html?token=${token}`;
    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;line-height:1.5">
        <p>We could not charge your card for ${escapeHtml(lost)}: ${escapeHtml(reason || 'your card was declined.')}</p>
        <p>You were not charged, and the lead could not go to your firm.</p>
        <p>To keep receiving leads, update your card under Manage Billing in your firm portal:</p>
        <p><a href="${url}" style="background:#9e3a5a;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open your firm portal</a></p>
        <p style="color:#777;font-size:12px">This link works for 30 days. NYCMalpractice.ai Lead Marketplace</p>
      </div>`;
    const t = getTransporter();
    if (!t) console.log(`[EMAIL MOCK] Card declined notice → ${firm.email}: ${lost}`);
    else await withTimeout(t.sendMail({ from: process.env.SMTP_USER, to: firm.email, subject: 'Your card was declined: update it to keep receiving leads', html }), 10_000);
    await notifyOperator(`Card declined: firm ${firm.id} lost ${lost}`,
      `<p>${escapeHtml(firm.name)} (firm ${escapeHtml(firm.id)}) could not be charged for ${escapeHtml(lost)}: ${escapeHtml(reason || 'declined')}. The firm has been emailed a portal link to update its card.</p>`);
    return true;
  } catch (err) {
    console.error(`The card-declined notice to firm ${firm?.id} failed:`, err.message);
    return false;
  }
}

export async function deliverColdLead(sessionId, caseType, scoreData, leadData) {
  const firms = await getActiveFirms(caseType);
  if (firms.length === 0) {
    // Nobody to sell it to: the operator is told, so a consented request is not silently lost.
    await sendAdminLeadAlert({ kind: 'cold', type: caseType, scoreData, sessionId, reason: 'no subscribed firm handles this case type' });
    return 0;
  }

  // At most three firms get a cold lead (the consent says "up to three"), tried in random order so every matching
  // firm has the same chance. It used to go to every matching firm.
  // A charge Stripe could not confirm counts toward the three too: the operator may deliver that lead by hand.
  let delivered = 0;
  let uncertain = 0;
  for (const firm of shuffled(firms)) {
    if (delivered + uncertain >= MAX_FIRMS_PER_LEAD) break;
    // Charged first: a firm whose card is missing or declined does not get the lead, and the next one is tried.
    const key = `cold-${sessionId}-${firm.id}`;
    const charge = await chargeFirm(firm, TIER_CONFIG.cold.reserve, `Cold malpractice lead — ${caseType}`, { sessionId, firmId: String(firm.id) }, key);
    if (charge.status === 'unknown') {
      await notifyOperator(`Cold lead: charge to firm ${firm.id} has an unknown outcome`,
        `<p>Stripe did not confirm or refuse the $${TIER_CONFIG.cold.reserve} charge to firm ${escapeHtml(firm.id)} for a cold lead (session ${escapeHtml(sessionId)}, idempotency key ${escapeHtml(key)}). The firm was not sent the lead. Check Stripe, then deliver the lead or refund the charge by hand.</p>`);
      uncertain += 1;
      continue;
    }
    if (charge.status !== 'charged') {
      await tellFirmChargeFailed(firm, { lost: `a new ${caseTypeLabel(caseType)} lead ($${TIER_CONFIG.cold.reserve})`, reason: charge.reason });
      continue;
    }

    let leadId;
    try {
      const deadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const [lead] = await sql`
        INSERT INTO leads (firm_id, session_id, case_type, tier, price_paid, stripe_charge_id, accept_deadline, lead_data)
        VALUES (${firm.id}, ${sessionId}, ${caseType}, 'cold', ${TIER_CONFIG.cold.reserve}, ${charge.id}, ${deadline}, ${JSON.stringify(leadData)})
        RETURNING id
      `;
      leadId = lead.id;
    } catch (err) {
      // Charged, but the lead could not be recorded: the charge is refunded and the operator told.
      console.error(`Cold lead for firm ${firm.id} charged but not recorded:`, err.message);
      const refunded = await createRefund({ paymentIntentId: charge.id, amountDollars: TIER_CONFIG.cold.reserve, idempotencyKey: `refund-${key}` })
        .then(() => true, () => false);
      await notifyOperator(`Cold lead for firm ${firm.id} charged but not delivered`,
        `<p>Firm ${escapeHtml(firm.id)} was charged (payment ${escapeHtml(charge.id)}) for a cold lead (session ${escapeHtml(sessionId)}), but the lead could not be recorded: ${escapeHtml(err.message)}.</p>` +
        `<p>${refunded ? 'The charge was refunded.' : 'The refund also failed: refund it in Stripe.'}</p>`);
      continue;
    }
    delivered += 1;   // the lead exists and is in the firm's portal, even if the email below fails
    try {
      const token = await createMagicLink(firm.id, { leadId, expiresInHours: 72 });
      await sendLeadDeliveryEmail(firm, leadId, token, leadData, scoreData, 'cold', TIER_CONFIG.cold.reserve);
    } catch (err) {
      await notifyOperator(`Lead #${leadId} was not emailed to firm ${firm.id}`,
        `<p>Firm ${escapeHtml(firm.id)} was charged and lead #${escapeHtml(leadId)} is in its portal, but the email failed: ${escapeHtml(err.message)}. Send the firm a portal link from the admin page.</p>`);
    }
  }
  if (delivered === 0) {
    await sendAdminLeadAlert({ kind: 'cold', type: caseType, scoreData, sessionId, reason: 'no matching firm could be charged' });
  }
  return delivered;
}

export async function createAuction(sessionId, caseType, scoreData, leadData) {
  const config   = TIER_CONFIG[scoreData.tier];
  const closesAt = new Date(Date.now() + config.auctionHours * 60 * 60 * 1000);
  const [auction] = await sql`
    INSERT INTO auctions (session_id, case_type, quality_score, tier, reserve_price, current_bid, closes_at, score_dimensions, lead_preview, lead_data)
    VALUES (${sessionId}, ${caseType}, ${scoreData.score}, ${scoreData.tier}, ${config.reserve}, ${config.reserve}, ${closesAt}, ${JSON.stringify(scoreData.dimensions)}, ${scoreData.preview}, ${JSON.stringify(leadData)})
    RETURNING *
  `;
  try {
    await notifyAllFirms(auction);
  } catch (err) {
    // Firms may not have been told about it: the auction is cancelled, so asking again starts a fresh one
    // rather than leaving a second, unseen auction for the same lead.
    await sql`UPDATE auctions SET status = 'cancelled' WHERE id = ${auction.id} AND status = 'open'`.catch(() => {});
    throw err;
  }
  return auction;
}

// A qualified lead the marketplace could not place: no matching firm, no bids, or no firm whose card could be
// charged. The client asked to be contacted, so the operator is told and can follow up by hand.
async function sendAdminLeadAlert({ kind, type, scoreData = {}, sessionId = null, reason }) {
  const tier  = scoreData?.tier || kind;
  const score = scoreData?.score ?? scoreData?.quality_score ?? '—';
  await notifyOperator(`⚠️ Malpractice lead not placed (${tier} / ${type || 'other'}): ${reason}`, `
    <div style="font-family:sans-serif;max-width:640px;margin:auto">
      <h2>⚠️ New Malpractice Lead Not Placed</h2>
      <p>A visitor asked to be contacted and the lead qualified, but it was not delivered: ${escapeHtml(reason)}.</p>
      <table style="width:100%;border-collapse:collapse;margin:1rem 0">
        <tr><td style="color:#666;padding:6px 0">Case Type</td><td>${escapeHtml(type || 'other')}</td></tr>
        <tr><td style="color:#666;padding:6px 0">Quality Score</td><td>${escapeHtml(score)}/100</td></tr>
        <tr><td style="color:#666;padding:6px 0">Tier</td><td>${escapeHtml(tier)}</td></tr>
        ${sessionId ? `<tr><td style="color:#666;padding:6px 0">Session</td><td>${escapeHtml(sessionId)}</td></tr>` : ''}
      </table>
      <p>The contact details are saved with the conversation.</p>
    </div>`);
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

// The highest bid accepted, in dollars: a typo or a forged amount (NaN, Infinity, a million) is refused.
const MAX_BID_DOLLARS = 5000;

export async function placeBid(auctionId, firmId, amount) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(value) || value <= 0) return { ok: false, error: 'Enter a bid in dollars.' };
  if (value > MAX_BID_DOLLARS) return { ok: false, error: `Bids are limited to $${MAX_BID_DOLLARS.toLocaleString('en-US')}.` };

  // One statement raises the bid only if it beats the current one by at least $1, and records it, so two bids
  // at the same moment cannot leave the lower one in the lead.
  const [placed] = await sql`
    WITH raised AS (
      UPDATE auctions SET current_bid = ${value}, current_leader_id = ${firmId}
      WHERE id = ${auctionId} AND status = 'open' AND closes_at > NOW() AND current_bid + 1 <= ${value}
      RETURNING id
    )
    INSERT INTO bids (auction_id, firm_id, amount)
    SELECT id, ${firmId}::int, ${value}::numeric FROM raised
    RETURNING id`;
  if (placed) return { ok: true, currentBid: value, leaderId: firmId };

  // Refused: say why.
  const [auction] = await sql`SELECT status, closes_at, current_bid FROM auctions WHERE id = ${auctionId} LIMIT 1`;
  if (!auction) return { ok: false, error: 'Auction not found' };
  if (auction.status !== 'open') return { ok: false, error: 'Auction is closed' };
  if (new Date(auction.closes_at) <= new Date()) return { ok: false, error: 'Auction has expired' };
  return { ok: false, error: `Minimum bid is $${(parseFloat(auction.current_bid) + 1).toFixed(2)}` };
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

// Closes an auction once its time is up. The highest bidder whose card can be charged wins and pays its own
// bid; a bidder whose card is missing or declined does not get the lead, and the next bidder is tried. With
// no bids, or no bidder that could be charged, the operator is told: the client asked to be contacted. When
// Stripe cannot say whether a charge went through, nobody else is charged and the auction is left 'closing'
// for the operator.
export async function closeAuction(auctionId) {
  // Claimed first, so two runs at once (the nightly job and a page visit) close it once.
  const [auction] = await sql`
    UPDATE auctions SET status = 'closing'
    WHERE id = ${auctionId} AND status = 'open' AND closes_at <= NOW()
    RETURNING *`;
  if (!auction) return null;

  const bids = await sql`
    SELECT firm_id, MAX(amount) AS amount FROM bids WHERE auction_id = ${auctionId}
    GROUP BY firm_id ORDER BY MAX(amount) DESC, MIN(created_at) ASC`;
  const declinedFirms = new Set();   // told why they did not get the lead, so not sent the losing-bidder email
  for (const bid of bids) {
    const firm = await getFirm(bid.firm_id);
    if (!firm || firm.active === false || !firm.subscription_active || !firm.approved_at) continue;
    if (firm.suspended_until && new Date(firm.suspended_until) > new Date()) continue;
    const amount = parseFloat(bid.amount);
    const key = `auction-${auctionId}-${firm.id}`;
    const charge = await chargeFirm(firm, amount, `Malpractice lead auction — ${auction.tier} / ${auction.case_type}`,
      { auctionId: String(auctionId), firmId: String(firm.id) }, key);
    if (charge.status === 'unknown') {
      await notifyOperator(`Auction #${auctionId}: charge to firm ${firm.id} has an unknown outcome`,
        `<p>Stripe did not confirm or refuse the $${amount.toFixed(2)} charge to firm ${escapeHtml(firm.id)} for auction #${escapeHtml(auctionId)} (idempotency key ${escapeHtml(key)}). No other bidder was charged and no lead was sent; the auction is left closing. Check Stripe, then deliver the lead or close the auction by hand.</p>`);
      return { pending: true };
    }
    if (charge.status !== 'charged') {
      declinedFirms.add(String(firm.id));
      await tellFirmChargeFailed(firm, { lost: `auction #${auctionId}, which your bid of $${amount.toFixed(2)} had won`, reason: charge.reason });
      continue;
    }

    let leadId;
    try {
      await sql`UPDATE auctions SET status = 'closed', winner_firm_id = ${firm.id}, winning_bid = ${amount} WHERE id = ${auctionId}`;
      const deadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const [lead] = await sql`
        INSERT INTO leads (auction_id, firm_id, session_id, case_type, tier, price_paid, stripe_charge_id, accept_deadline)
        VALUES (${auctionId}, ${firm.id}, ${auction.session_id}, ${auction.case_type}, ${auction.tier}, ${amount}, ${charge.id}, ${deadline})
        RETURNING id`;
      leadId = lead.id;
    } catch (err) {
      await notifyOperator(`Auction #${auctionId}: firm ${firm.id} charged but the win was not recorded`,
        `<p>Firm ${escapeHtml(firm.id)} was charged $${amount.toFixed(2)} (payment ${escapeHtml(charge.id)}) for auction #${escapeHtml(auctionId)}, but recording the win failed: ${escapeHtml(err.message)}. Record the lead or refund the charge by hand.</p>`);
      throw err;
    }
    try {
      const token = await createMagicLink(firm.id, { leadId, expiresInHours: 72 });
      await sendLeadDeliveryEmail(firm, leadId, token, auction.lead_data, auction, auction.tier, amount);
    } catch (err) {
      await notifyOperator(`Lead #${leadId} was not emailed to firm ${firm.id}`,
        `<p>Firm ${escapeHtml(firm.id)} won auction #${escapeHtml(auctionId)} and was charged $${amount.toFixed(2)}; lead #${escapeHtml(leadId)} is in its portal, but the email failed: ${escapeHtml(err.message)}. Send the firm a portal link from the admin page.</p>`);
    }
    for (const other of bids.filter(b => String(b.firm_id) !== String(firm.id) && !declinedFirms.has(String(b.firm_id)))) {
      try {
        const loser = await getFirm(other.firm_id);
        if (loser) await sendLoserEmail(loser, auction, amount);
      } catch (err) {
        console.error(`Auction ${auctionId}: the email to losing firm ${other.firm_id} failed:`, err.message);
      }
    }
    console.log(`Auction ${auctionId} closed — winner: firm ${firm.id}, charged $${amount}`);
    return { winnerFirmId: firm.id, amount };
  }

  await sql`UPDATE auctions SET status = 'cancelled' WHERE id = ${auctionId}`;
  await sendAdminLeadAlert({
    kind: 'auction', type: auction.case_type, scoreData: auction, sessionId: auction.session_id,
    reason: bids.length ? 'no bidder could be charged' : 'the auction closed with no bids',
  });
  return null;
}

// Closes every auction past its time. Run by the nightly job and, since that job runs only once a day on this
// hosting plan, also by requests from firms and visitors (sweepExpiredAuctions in server.js).
export async function closeExpiredAuctions() {
  const expired = await sql`SELECT id FROM auctions WHERE status = 'open' AND closes_at <= NOW() ORDER BY closes_at`;
  for (const row of expired) {
    try { await closeAuction(row.id); }
    catch (err) { console.error(`Closing auction ${row.id} failed:`, err.message); }
  }
  return expired.length;
}

// An auction left 'closing' for over an hour stopped part-way: a charge had an unknown outcome, or recording
// the win failed. The operator checks Stripe and the leads table, then finishes it by hand.
export async function reportStuckAuctions() {
  const stuck = await sql`SELECT id FROM auctions WHERE status = 'closing' AND closes_at < NOW() - INTERVAL '1 hour'`;
  if (!stuck.length) return 0;
  const ids = stuck.map(row => `#${row.id}`).join(', ');
  await notifyOperator(`Auctions stuck while closing: ${ids}`,
    `<p>These auctions began closing but did not finish: ${ids}. Check Stripe for a charge and the leads table before finishing them by hand.</p>`);
  return stuck.length;
}

// `attestation` is the supervising attorney's three checks (lead.html), stored with the lead as the record of them.
export async function acceptLead(leadId, firmId, attestation = null) {
  const [lead] = await sql`SELECT * FROM leads WHERE id = ${leadId} AND firm_id = ${firmId} LIMIT 1`;
  if (!lead) return { ok: false, error: 'Lead not found' };
  if (lead.status !== 'pending') return { ok: false, error: `Lead already ${lead.status}` };
  const [claimed] = await sql`
    UPDATE leads SET status = 'accepted', accepted_at = NOW(), hitl_verification = ${attestation ? JSON.stringify(attestation) : null}
    WHERE id = ${leadId} AND status = 'pending' RETURNING id`;
  if (!claimed) return { ok: false, error: 'Lead already answered' };
  // The client hears which firm accepted, by email if they gave an address; nobody used to tell them anything.
  const clientTold = await notifyClientOfAcceptance(lead, firmId)
    .catch(err => { console.error(`The acceptance notice for lead ${leadId} failed:`, err.message); return false; });
  return { ok: true, clientTold };
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
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'mail.jwd.nyc', port: 465, secure: true, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // A stalled mail server is given up on after 10 seconds; nodemailer would wait minutes, past the time
    // limit of the request that is sending.
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000,
  });
}

async function sendLeadDeliveryEmail(firm, leadId, token, leadData, scoreData, tier, amountCharged) {
  const url        = `${APP_URL}/lead.html?id=${leadId}&token=${token}`;
  const tierConfig = TIER_CONFIG[tier] || TIER_CONFIG.cold;
  const data       = typeof leadData === 'string' ? JSON.parse(leadData) : leadData;
  const t          = getTransporter();
  const html = `<div style="font-family:sans-serif;max-width:640px;margin:auto"><h2 style="color:#9e3a5a">✅ New Malpractice Lead — ${tierConfig.label}</h2><p>You have <strong>3 days</strong> to accept or decline.</p><p>Amount charged: $${Number(amountCharged ?? tierConfig.reserve).toFixed(2)}</p><p><strong>Preview:</strong><br>${escapeHtml(scoreData.lead_preview || scoreData.preview || '')}</p><p><a href="${url}" style="background:#9e3a5a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View Lead →</a></p></div>`;
  if (!t) { console.log(`[EMAIL MOCK] Lead delivery → ${firm.email}`); return; }
  await t.sendMail({ from: process.env.SMTP_USER, to: firm.email, subject: `✅ New Malpractice Lead: ${tierConfig.label} — ${data?.caseType || 'Medical Malpractice'}`, html });
}

async function notifyAllFirms(auction) {
  const firms  = await getActiveFirms(auction.case_type);
  if (firms.length === 0) {
    // Nobody to offer it to: cancelled at once, and the operator is told.
    await sql`UPDATE auctions SET status = 'cancelled' WHERE id = ${auction.id} AND status = 'open'`;
    await sendAdminLeadAlert({ kind: 'auction', type: auction.case_type, scoreData: auction, sessionId: auction.session_id, reason: 'no subscribed firm handles this case type' });
    return;
  }
  const config = TIER_CONFIG[auction.tier];
  const t      = getTransporter();
  for (const firm of firms) {
    try {
      const token    = await createMagicLink(firm.id, { auctionId: auction.id, expiresInHours: config.auctionHours + 1 });
      const url      = `${APP_URL}/auction.html?id=${auction.id}&token=${token}`;
      const closesAt = new Date(auction.closes_at).toLocaleString('en-US', { timeZone: 'America/New_York' });
      const html = `<div style="font-family:sans-serif;max-width:640px;margin:auto"><h2 style="color:#9e3a5a">🔔 New Malpractice Lead Auction — ${config.label}</h2><p><strong>Preview:</strong><br>${escapeHtml(auction.lead_preview)}</p><p>Reserve: $${config.reserve} · Closes: ${closesAt} ET</p><p><a href="${url}" style="background:#9e3a5a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Bid →</a></p></div>`;
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

// A fair order for the firms offered a cold lead.
function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} seconds`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Emails the client that a firm has accepted their request, with the firm's name and how to reach it, if they
// gave an email address in the contact form. Returns whether a notice went out.
async function notifyClientOfAcceptance(lead, firmId) {
  let data = lead.lead_data;
  if (lead.auction_id) {
    const [auction] = await sql`SELECT lead_data FROM auctions WHERE id = ${lead.auction_id}`;
    data = auction?.lead_data;
  }
  if (typeof data === 'string') data = JSON.parse(data);
  const contact = data?.contact || {};
  if (typeof contact.email !== 'string' || !contact.email.includes('@')) return false;
  const firm = await getFirm(firmId);
  if (!firm) return false;

  const digits = String(firm.phone || '').replace(/\D/g, '').slice(-10);
  const phone = digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : String(firm.phone || '');
  const reach = [phone && `by phone at ${escapeHtml(phone)}`, firm.email && `by email at ${escapeHtml(firm.email)}`].filter(Boolean).join(' or ');
  const html = `
    <div style="font-family:sans-serif;max-width:580px;margin:auto;line-height:1.5">
      <p>Hello ${escapeHtml(contact.name || '')},</p>
      <p><strong>${escapeHtml(firm.name)}</strong>, a New York law firm, has accepted your request for a free consultation and will contact you${contact.phone ? ' at the phone number you gave us' : ''}.</p>
      ${reach ? `<p>You can also reach them ${reach}.</p>` : ''}
      <p>NYCMalpractice.ai is not a law firm and is not part of this firm. You are free to speak with any attorney you choose, and to ask any attorney how fees and case costs would work before you agree to anything.</p>
      <p style="color:#777;font-size:12px">You are receiving this because you asked NYCMalpractice.ai to connect you with an attorney. To withdraw your consent to be contacted, email privacy@nycmalpractice.ai.</p>
    </div>`;
  const t = getTransporter();
  if (!t) { console.log(`[EMAIL MOCK] Acceptance notice → client of lead ${lead.id}`); return true; }
  await withTimeout(t.sendMail({
    from: process.env.SMTP_USER,
    to: contact.email,
    subject: `${firm.name} has accepted your consultation request`,
    html,
  }), 10_000);
  return true;
}
