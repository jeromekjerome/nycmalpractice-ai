// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Prints the record of one demo auction as JSON: how it was scored, who bid, what the winner was charged, and the
// test payment as Stripe holds it. It also adds up what the AI calls have cost since the demo was last seeded.
// For showing, in a walkthrough of the demo, that the charge is a real payment in Stripe's test mode.
//
//   DEMO_DATABASE_URL=postgres://...   the demo database. This tool never reads DATABASE_URL, and refuses the live one.
//   STRIPE_SECRET_KEY=sk_test_...      optional: the payment is then read back from Stripe. A live key is refused.
//
//   node demo/auction-facts.mjs 9
//
// It only reads. It prints no client's name, contact details or words, and no key.
import { neon } from '@neondatabase/serverless';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseRefusal, stripeKeyRefusal } from './guards.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { console.error(`\n✗ ${message}\n`); process.exit(1); };

const demoUrl = process.env.DEMO_DATABASE_URL;
const liveUrl = existsSync(join(root, '.env')) ? dotenv.parse(readFileSync(join(root, '.env'))).DATABASE_URL : null;
const refused = databaseRefusal(demoUrl, liveUrl) || stripeKeyRefusal(process.env.STRIPE_SECRET_KEY);
if (refused) fail(refused);

const sql = neon(demoUrl);
const auctionId = /^\d+$/.test(process.argv[2] || '') ? Number(process.argv[2]) : NaN;
if (!Number.isInteger(auctionId) || auctionId <= 0) fail('Give the auction\'s number, e.g. node demo/auction-facts.mjs 9');
if (!(await sql`SELECT to_regclass('public.demo_environment') IS NOT NULL AS found`)[0].found) fail('This database is not marked as the demo. Refusing to read it.');

const [auction] = await sql`
  SELECT a.id, a.session_id, a.case_type, a.tier, a.quality_score, a.reserve_price, a.winning_bid, a.status, a.created_at, a.closes_at,
         a.score_dimensions, f.name AS winner
  FROM auctions a LEFT JOIN firms f ON f.id = a.winner_firm_id WHERE a.id = ${auctionId}`;
if (!auction) fail(`There is no auction ${auctionId} in the demo.`);

const bids = await sql`SELECT f.name AS firm, b.amount, b.created_at FROM bids b JOIN firms f ON f.id = b.firm_id WHERE b.auction_id = ${auctionId} ORDER BY b.created_at`;
const [lead] = await sql`
  SELECT l.id, l.tier, l.price_paid, l.status, l.stripe_charge_id, l.accepted_at, l.hitl_verification, f.name AS firm
  FROM leads l JOIN firms f ON f.id = l.firm_id WHERE l.auction_id = ${auctionId} ORDER BY l.id LIMIT 1`;
const [conversation] = await sql`SELECT case_type, mode, contact_consent_at, lead_score FROM conversations WHERE session_id = ${auction.session_id}`;
const [usage] = await sql`SELECT count(*)::int AS calls, COALESCE(sum(actual_cost_usd), 0)::float AS cost_usd, min(created_at) AS first_call, max(created_at) AS last_call FROM ai_usage`;

let payment = null;
if (lead?.stripe_charge_id && process.env.STRIPE_SECRET_KEY) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const intent = await stripe.paymentIntents.retrieve(lead.stripe_charge_id);
  payment = { id: intent.id, amount: intent.amount / 100, currency: intent.currency, status: intent.status, livemode: intent.livemode,
    description: intent.description, created: new Date(intent.created * 1000).toISOString() };
}

console.log(JSON.stringify({
  auction: { id: auction.id, caseType: auction.case_type, tier: auction.tier, score: auction.quality_score, dimensions: auction.score_dimensions,
    reserve: Number(auction.reserve_price), winningBid: auction.winning_bid == null ? null : Number(auction.winning_bid), status: auction.status,
    winner: auction.winner, openedAt: auction.created_at, closesAt: auction.closes_at },
  bids: bids.map(bid => ({ firm: bid.firm, amount: Number(bid.amount), at: bid.created_at })),
  lead: lead ? { id: lead.id, firm: lead.firm, tier: lead.tier, pricePaid: Number(lead.price_paid), status: lead.status, acceptedAt: lead.accepted_at,
    attorneyChecks: lead.hitl_verification } : null,
  conversation: conversation ? { caseType: conversation.case_type, mode: conversation.mode, consentedAt: conversation.contact_consent_at,
    scoredTier: conversation.lead_score?.tier ?? null, scored: conversation.lead_score?.score ?? null } : null,
  payment,
  aiSinceSeed: { calls: usage.calls, costUsd: Math.round(usage.cost_usd * 10000) / 10000, firstCall: usage.first_call, lastCall: usage.last_call },
}, null, 2));
