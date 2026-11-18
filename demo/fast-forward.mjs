// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Moves one open demo auction's closing time into the past, so the next request to the demo site closes it: the
// leading firm's test card is charged and the lead is delivered, exactly as when an auction runs out on its own.
// A hot auction runs four hours, and a walkthrough of the demo cannot wait that long.
//
//   DEMO_DATABASE_URL=postgres://...   the demo database. This tool never reads DATABASE_URL, and refuses the live one.
//
//   node demo/fast-forward.mjs 12      closes auction 12 on the next request to the demo site
//
// It changes that one row and nothing else, and only in a database the seed has marked as the demo.
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseRefusal, fastForwardRefusal } from './guards.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { console.error(`\n✗ ${message}\n`); process.exit(1); };

const demoUrl = process.env.DEMO_DATABASE_URL;
const liveUrl = existsSync(join(root, '.env')) ? dotenv.parse(readFileSync(join(root, '.env'))).DATABASE_URL : null;
const refusedDatabase = databaseRefusal(demoUrl, liveUrl);
if (refusedDatabase) fail(refusedDatabase);

const sql = neon(demoUrl);
const auctionId = /^\d+$/.test(process.argv[2] || '') ? Number(process.argv[2]) : NaN;
const marked = (await sql`SELECT to_regclass('public.demo_environment') IS NOT NULL AS found`)[0].found;
const [auction] = marked && Number.isInteger(auctionId)
  ? await sql`SELECT id, status, tier, current_bid, current_leader_id FROM auctions WHERE id = ${auctionId}`
  : [];
const refused = fastForwardRefusal({ marked, auctionId, auction });
if (refused) fail(refused);

const [moved] = await sql`UPDATE auctions SET closes_at = NOW() - INTERVAL '1 minute' WHERE id = ${auctionId} AND status = 'open' RETURNING id`;
if (!moved) fail(`Auction ${auctionId} was closed by something else just now. Nothing was changed.`);

console.log(`Auction ${auctionId} (${auction.tier}) now counts as run out. The next request to the demo site closes it${
  auction.current_leader_id ? `: the leading firm is charged $${Number(auction.current_bid)} on its test card and receives the lead` : ' with no winner, and the lead is offered at the cold price'}.`);
