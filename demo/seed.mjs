// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Proprietary and confidential. See LICENSE for terms.

// Fills the demo database with synthetic firms, conversations, auctions and leads (demo/synthetic-data.mjs), so the
// demo copy of the site can be shown end to end without a real patient or a real firm in it.
//
//   DEMO_DATABASE_URL=postgres://...   the demo database. The seed never reads DATABASE_URL, and refuses the live one.
//   STRIPE_SECRET_KEY=sk_test_...      optional: firms get Stripe test customers and cards, and lead charges are real
//                                      test-mode charges. A live key is refused. Without one, firms have no billing.
//   DEMO_APP_URL=https://...           the demo site's address, for the links printed at the end.
//
//   node demo/seed.mjs            seeds an empty database (and marks it as the demo)
//   node demo/seed.mjs --reset    empties a database already marked as the demo, then seeds it again
import { neon } from '@neondatabase/serverless';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTACT_CONSENT_TEXT, APP_ID } from '../site.js';
import { deadlineNotices } from '../deadlines.js';
import { databaseRefusal, stripeKeyRefusal } from './guards.mjs';
import { FIRMS, CASES, DEMO_TIERS } from './synthetic-data.mjs';


const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { console.error(`\n✗ ${message}\n`); process.exit(1); };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.now();
const at = offsetMs => new Date(now + offsetMs);
const token = () => randomBytes(32).toString('hex');

// ── Guards ────────────────────────────────────────────────────────────────────
const demoUrl = process.env.DEMO_DATABASE_URL;
const liveUrl = existsSync(join(root, '.env')) ? dotenv.parse(readFileSync(join(root, '.env'))).DATABASE_URL : null;
const refused = databaseRefusal(demoUrl, liveUrl) || stripeKeyRefusal(process.env.STRIPE_SECRET_KEY);
if (refused) fail(refused);
const reset = process.argv.includes('--reset');
const sql = neon(demoUrl);
const appUrl = (process.env.DEMO_APP_URL || 'http://localhost:3003').replace(/\/+$/, '');

const tableExists = async name => (await sql`SELECT to_regclass(${'public.' + name}) IS NOT NULL AS found`)[0].found;
const rowCount = async name => ((await tableExists(name)) ? Number((await sql.query(`SELECT count(*)::int AS n FROM ${name}`))[0].n) : 0);

if (!(await tableExists('demo_environment'))) {
  // An unmarked database is taken only if it holds nothing a person typed or a firm bought.
  const used = (await rowCount('firms')) + (await rowCount('conversations')) + (await rowCount('leads'));
  if (used > 0) fail('This database has data and is not marked as the demo. Refusing to touch it.');
  await sql`CREATE TABLE demo_environment (note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`INSERT INTO demo_environment (note) VALUES ('Synthetic demo data only, written by demo/seed.mjs')`;
  console.log('Marked the database as the demo.');
}

// ── Schema: the app's own setup, run against the demo database ────────────────
const setup = spawnSync(process.execPath, ['setup-db.js'], { cwd: root, env: { ...process.env, DATABASE_URL: demoUrl }, stdio: 'inherit' });
if (setup.status !== 0) fail('setup-db.js failed against the demo database.');
await sql`
  CREATE TABLE IF NOT EXISTS demo_outbox (
    id BIGSERIAL PRIMARY KEY, channel TEXT NOT NULL, recipient TEXT, subject TEXT, body TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;

if (reset) {
  await sql`TRUNCATE bids, leads, auctions, firm_tokens, phone_codes, firms, conversations, user_interactions, job_runs, ai_usage, demo_outbox RESTART IDENTITY CASCADE`;
  console.log('Emptied the demo database.');
} else if ((await rowCount('firms')) > 0) {
  fail('The demo database is already seeded. Run with --reset to start it over.');
}

// ── Stripe test mode ──────────────────────────────────────────────────────────
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeKey ? new Stripe(stripeKey) : null;
if (!stripe) console.warn('No Stripe test key: the firms get no billing account, so lead charges in the demo will be declined.');

// Stripe's test cards: one that pays, and one that attaches to the customer but declines every charge.
const TEST_CARD = { ok: 'pm_card_visa', declines: 'pm_card_chargeCustomerFail' };

async function billingFor(firm, firmId) {
  if (!stripe) return { customer: null, card: null };
  const customer = await stripe.customers.create({ name: firm.name, email: firm.email, metadata: { firmId: String(firmId), app: APP_ID, demo: 'true' } });
  const card = await stripe.paymentMethods.attach(firm.state === 'declined' ? TEST_CARD.declines : TEST_CARD.ok, { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: card.id } });
  return { customer: customer.id, card: card.id };
}

// A lead charge as the app makes it (stripe.js chargeCustomer), in test mode; a placeholder id without Stripe.
async function charge(firmRow, dollars, description, sessionId) {
  if (!stripe || !firmRow.stripe_customer_id) return `pi_demo_${randomBytes(6).toString('hex')}`;
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(dollars * 100), currency: 'usd', customer: firmRow.stripe_customer_id, payment_method: firmRow.stripe_payment_method_id,
    confirm: true, off_session: true, description, metadata: { app: APP_ID, demo: 'true', sessionId },
  });
  return intent.id;
}

async function refund(chargeId, dollars) {
  if (!stripe || chargeId.startsWith('pi_demo_')) return `re_demo_${randomBytes(6).toString('hex')}`;
  return (await stripe.refunds.create({ payment_intent: chargeId, amount: Math.round(dollars * 100) })).id;
}

// ── Firms ─────────────────────────────────────────────────────────────────────
const firms = {};
for (const firm of FIRMS) {
  const approved = ['ready', 'suspended', 'declined'].includes(firm.state);
  const paying = firm.state !== 'unfinished';
  const [row] = await sql`
    INSERT INTO firms (name, email, phone, phone_verified, active, subscription_active, subscription_status, specializations, service_area,
                       contact_name, attorney_name, attorney_registration, approved_at, terms_accepted_at, suspended_until,
                       auction_decline_count, card_declined_at, created_at)
    VALUES (${firm.name}, ${firm.email}, ${firm.phone}, ${paying}, TRUE, ${paying}, ${paying ? 'active' : null}, ${firm.areas}::text[], ${firm.area},
            ${firm.attorney}, ${firm.attorney}, ${firm.registration}, ${approved ? at(-20 * DAY) : null}, ${at(-21 * DAY)},
            ${firm.state === 'suspended' ? at(22 * DAY) : null}, ${firm.state === 'suspended' ? 3 : 0},
            ${firm.state === 'declined' ? at(-1 * DAY) : null}, ${at(-21 * DAY)})
    RETURNING *`;
  if (paying) {
    const billing = await billingFor(firm, row.id);
    const [updated] = await sql`UPDATE firms SET stripe_customer_id = ${billing.customer}, stripe_payment_method_id = ${billing.card} WHERE id = ${row.id} RETURNING *`;
    firms[firm.key] = updated;
  } else {
    firms[firm.key] = row;
  }
}
console.log(`Firms: ${FIRMS.length}`);

// ── Conversations, auctions and leads ─────────────────────────────────────────
const asHistory = pairs => pairs.map(([role, content]) => ({ role, content }));
let auctionCount = 0;
let leadCount = 0;

async function insertLead({ auctionId = null, firm, sessionId, caseType, tier, price, chargeId, createdAt, leadData = null, status = 'pending', declineReason = null, refundAmount = null }) {
  const accepted = status === 'accepted';
  const declined = status === 'declined';
  const refundId = declined && refundAmount ? await refund(chargeId, refundAmount) : null;
  const attestation = accepted ? {
    sol_and_notice_verified: true, conflict_check_completed: true, case_quality_reviewed: true,
    attestedAt: new Date(createdAt.getTime() + 5 * HOUR).toISOString(), attorneyOnFile: firm.attorney_name, attorneyRegistrationOnFile: firm.attorney_registration,
  } : null;
  await sql`
    INSERT INTO leads (auction_id, firm_id, session_id, case_type, tier, price_paid, stripe_charge_id, status, accept_deadline, created_at,
                       lead_data, accepted_at, hitl_verification, declined_at, decline_reason, refund_amount, stripe_refund_id)
    VALUES (${auctionId}, ${firm.id}, ${sessionId}, ${caseType}, ${tier}, ${price}, ${chargeId}, ${status}, ${new Date(createdAt.getTime() + 3 * DAY)}, ${createdAt},
            ${leadData ? JSON.stringify(leadData) : null}::jsonb, ${accepted ? new Date(createdAt.getTime() + 5 * HOUR) : null},
            ${attestation ? JSON.stringify(attestation) : null}::jsonb, ${declined ? new Date(createdAt.getTime() + 8 * HOUR) : null},
            ${declineReason}, ${refundAmount}, ${refundId})`;
  leadCount++;
}

async function insertAuction({ sessionId, item, status, closesAt, leadData, bids = [], invite = [], winner = null }) {
  const config = DEMO_TIERS[item.tier];
  const last = bids.at(-1);
  const createdAt = new Date(closesAt.getTime() - config.auctionHours * HOUR);
  const [auction] = await sql`
    INSERT INTO auctions (session_id, case_type, quality_score, tier, reserve_price, current_bid, current_leader_id, winner_firm_id, winning_bid,
                          status, closes_at, score_dimensions, lead_preview, lead_data, created_at)
    VALUES (${sessionId}, ${item.caseType}, ${item.score}, ${item.tier}, ${config.reserve}, ${last ? last[1] : config.reserve},
            ${last ? firms[last[0]].id : null}, ${winner ? firms[winner].id : null}, ${winner ? last[1] : null}, ${status}, ${closesAt},
            ${JSON.stringify(item.dimensions)}::jsonb, ${item.preview}, ${JSON.stringify(leadData)}::jsonb, ${createdAt})
    RETURNING id`;
  for (const [i, [key, amount]] of bids.entries()) {
    const placed = new Date(createdAt.getTime() + (i + 1) * Math.max(10 * MINUTE, (closesAt - createdAt) / (bids.length + 2)));
    await sql`INSERT INTO bids (auction_id, firm_id, amount, created_at) VALUES (${auction.id}, ${firms[key].id}, ${amount}, ${new Date(Math.min(placed, now - MINUTE))})`;
  }
  // The invitation links the firms were emailed; the portal lists an open auction to the firms that have one.
  for (const key of invite) {
    await sql`INSERT INTO firm_tokens (firm_id, token, auction_id, expires_at, created_at) VALUES (${firms[key].id}, ${token()}, ${auction.id}, ${new Date(closesAt.getTime() + HOUR)}, ${createdAt})`;
  }
  auctionCount++;
  return auction.id;
}

for (const item of CASES) {
  const sessionId = `demo-${item.key}`;
  const history = asHistory(item.history);
  const contact = item.contact ? { ...item.contact, email: item.contact.email || null, bestTime: item.contact.bestTime || null } : null;
  const startedAt = item.outcome === 'auction-open' ? at(-(DEMO_TIERS[item.tier].auctionHours * HOUR - item.closesInMinutes * MINUTE) - 20 * MINUTE)
    : item.closedMinutesAgo ? at(-(item.closedMinutesAgo * MINUTE + (DEMO_TIERS[item.tier]?.auctionHours || 0) * HOUR) - 20 * MINUTE)
    : at(-20 * HOUR);
  const consentedAt = contact ? new Date(startedAt.getTime() + 15 * MINUTE) : null;
  const scoredAt = item.tier ? new Date(startedAt.getTime() + 12 * MINUTE).toISOString() : null;
  const leadScore = item.tier
    ? { viable: true, score: item.score, confidence: 0.8, preview: item.preview, dimensions: item.dimensions, tier: item.tier, reserve: DEMO_TIERS[item.tier].reserve, scoredAt }
    : null;
  const sent = ['auction-open', 'auction-won', 'no-bids', 'cold'].includes(item.outcome);
  await sql`
    INSERT INTO conversations (session_id, mode, case_type, history, name, phone, best_time, email, lead_score, contact_consent_at, contact_consent_text, lead_sent_at, updated_at)
    VALUES (${sessionId}, ${item.mode}, ${item.caseType}, ${JSON.stringify(history)}::jsonb, ${contact?.name || null}, ${contact?.phone || null},
            ${contact?.bestTime || null}, ${contact?.email || null}, ${leadScore ? JSON.stringify(leadScore) : null}::jsonb, ${consentedAt},
            ${contact ? CONTACT_CONSENT_TEXT : null}, ${sent ? consentedAt : null}, ${consentedAt || new Date(startedAt.getTime() + 10 * MINUTE)})`;
  if (!sent) continue;

  // What a firm receives (leadDataFrom in server.js).
  const leadData = {
    caseType: item.caseType, mode: item.mode, history, preview: item.preview, score: item.score, dimensions: item.dimensions, scoredAt,
    deadlines: deadlineNotices(history),
    contact: { ...contact, consentedAt: consentedAt.toISOString(), consentText: CONTACT_CONSENT_TEXT },
    evaluation: null,
  };

  if (item.outcome === 'auction-open') {
    await insertAuction({ sessionId, item, status: 'open', closesAt: at(item.closesInMinutes * MINUTE), leadData, bids: item.bids, invite: item.invite });
  } else if (item.outcome === 'auction-won') {
    const closesAt = at(-item.closedMinutesAgo * MINUTE);
    const winnerKey = item.bids.at(-1)[0];
    const auctionId = await insertAuction({ sessionId, item, status: 'closed', closesAt, leadData, bids: item.bids, invite: item.invite, winner: winnerKey });
    const price = item.bids.at(-1)[1];
    const chargeId = await charge(firms[winnerKey], price, `Malpractice lead auction #${auctionId} (demo)`, sessionId);
    await insertLead({ auctionId, firm: firms[winnerKey], sessionId, caseType: item.caseType, tier: item.tier, price, chargeId, createdAt: closesAt, status: item.leadStatus });
  } else {
    let deliveredAt = at(-18 * HOUR);
    if (item.outcome === 'no-bids') {
      const closesAt = at(-item.closedMinutesAgo * MINUTE);
      await insertAuction({ sessionId, item, status: 'cancelled', closesAt, leadData, invite: item.invite });
      deliveredAt = new Date(closesAt.getTime() + MINUTE);
    }
    for (const [key, status, reason] of item.coldTo) {
      const chargeId = await charge(firms[key], 25, `Cold malpractice lead (demo)`, sessionId);
      // A firm's first cold decline in 30 days is refunded in full (Terms, section 5).
      await insertLead({ firm: firms[key], sessionId, caseType: item.caseType, tier: 'cold', price: 25, chargeId, createdAt: deliveredAt, leadData,
        status, declineReason: reason || null, refundAmount: status === 'declined' ? 25 : null });
    }
  }
}

// The suspended firm earned it: three auction leads declined within 30 days, refunded 50%, 25%, then nothing.
for (const [i, refundPct] of [50, 25, 0].entries()) {
  const sessionId = `demo-okafor-declined-${i + 1}`;
  const item = { caseType: 'surgical_error', tier: 'warm', score: 70, preview: 'Synthetic earlier lead, declined by the firm.', dimensions: {} };
  const closesAt = at(-(20 - i * 6) * DAY);
  const leadData = { caseType: item.caseType, mode: 'personal', history: [], preview: item.preview, contact: null, evaluation: null };
  const auctionId = await insertAuction({ sessionId, item, status: 'closed', closesAt, leadData, bids: [['okafor', 120]], winner: 'okafor' });
  const chargeId = await charge(firms.okafor, 120, `Malpractice lead auction #${auctionId} (demo)`, sessionId);
  await insertLead({ auctionId, firm: firms.okafor, sessionId, caseType: item.caseType, tier: item.tier, price: 120, chargeId, createdAt: closesAt,
    status: 'declined', declineReason: 'not_taking', refundAmount: refundPct ? 120 * refundPct / 100 : null });
}
console.log(`Conversations: ${CASES.length} · auctions: ${auctionCount} · leads: ${leadCount}`);

// ── Sign-in links for the walkthrough ─────────────────────────────────────────
console.log(`\nDemo site: ${appUrl}\nAdmin page: ${appUrl}/admin.html (the demo's ADMIN_SECRET)\nOutbox: ${appUrl}/demo/outbox\n\nFirm portals (links valid 30 days):`);
for (const firm of FIRMS) {
  const portal = token();
  await sql`INSERT INTO firm_tokens (firm_id, token, expires_at) VALUES (${firms[firm.key].id}, ${portal}, ${at(30 * DAY)})`;
  console.log(`  ${firm.name.padEnd(32)} ${firm.state.padEnd(10)} ${appUrl}/portal.html?token=${portal}`);
}
console.log('');
