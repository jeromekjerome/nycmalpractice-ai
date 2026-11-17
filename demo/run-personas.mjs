// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Proprietary and confidential. See LICENSE for terms.

// Plays synthetic patients and families (PERSONAS in demo/synthetic-data.mjs) through the demo site's real chat,
// one message at a time, then sends the contact form for each, so new leads reach the synthetic firms the way a
// real visitor's would: the live AI replies, scores the conversation and decides where the lead goes.
//
//   node demo/run-personas.mjs <demo site address> [persona keys...] [--pace=65]
//
// It talks only to a site whose /api/site-mode says it is the demo copy, never to the live one. --pace is the wait
// between messages in seconds: each reply searches CourtListener, whose token allows 5 calls a minute.
import { randomBytes } from 'node:crypto';
import { siteRefusal } from './guards.mjs';
import { PERSONAS } from './synthetic-data.mjs';

const args = process.argv.slice(2);
const baseUrl = (args.find(arg => !arg.startsWith('--') && /^https?:/.test(arg)) || '').replace(/\/+$/, '');
const wanted = args.filter(arg => !arg.startsWith('--') && !/^https?:/.test(arg));
const pace = Number((args.find(arg => arg.startsWith('--pace=')) || '--pace=65').split('=')[1]);
const fail = message => { console.error(`\n✗ ${message}\n`); process.exit(1); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const refused = siteRefusal(baseUrl);
if (refused) fail(refused);
const mode = await fetch(`${baseUrl}/api/site-mode`).then(res => (res.ok ? res.json() : null), () => null);
if (!mode?.demo) fail(`${baseUrl} does not say it is the demo copy (GET /api/site-mode). Refusing to send synthetic messages to it.`);

const personas = wanted.length ? PERSONAS.filter(persona => wanted.includes(persona.key)) : PERSONAS;
if (personas.length === 0) fail(`No persona matches ${wanted.join(', ')}. Choose from: ${PERSONAS.map(p => p.key).join(', ')}`);

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let first = true;
for (const persona of personas) {
  const sessionId = `persona-${persona.key}-${randomBytes(4).toString('hex')}`;
  console.log(`\n━━ ${persona.key} (${persona.mode}) · session ${sessionId}`);
  let last = {};
  for (const [i, question] of persona.messages.entries()) {
    if (!first) await sleep(pace * 1000);
    first = false;
    let reply = await post('/api/ask', { question, sessionId, mode: persona.mode });
    if (reply.status === 503 && reply.body.retry) { await sleep(pace * 1000); reply = await post('/api/ask', { question, sessionId, mode: persona.mode }); }
    if (reply.status !== 200) { console.log(`  ${i + 1}. HTTP ${reply.status}: ${reply.body.error || 'no reply'}`); break; }
    last = reply.body;
    const notes = [
      last.caseType && `type ${last.caseType}`,
      last.leadTier ? `tier ${last.leadTier}` : 'not scored as a lead yet',
      last.deadlineNotices?.length && `deadline notices: ${last.deadlineNotices.join(', ')}`,
      last.evaluation?.gate_status && `gate ${last.evaluation.gate_status}`,
      last.cases?.length && `${last.cases.length} case(s) cited`,
      last.contactForm && 'contact form offered',
    ].filter(Boolean).join(' · ');
    console.log(`  ${i + 1}. ${question.slice(0, 90)}${question.length > 90 ? '…' : ''}\n     → ${String(last.answer || '').replace(/\s+/g, ' ').slice(0, 160)}…\n     ${notes}`);
  }
  if (!last.contactForm) { console.log('  The contact form was not offered, so no request was sent.'); continue; }
  const sent = await post('/api/contact', { sessionId, ...persona.contact, consent: true });
  console.log(sent.status === 200
    ? `  Contact form sent: ${sent.body.leadTier ? `${sent.body.leadTier} lead${sent.body.leadTier === 'cold' ? ', delivered to up to 3 firms' : ', auction opened'}` : 'not a qualified lead; the operator was told'}`
    : `  Contact form failed: HTTP ${sent.status} ${sent.body.error || ''}`);
}
console.log(`\nSee what was sent: ${baseUrl}/demo/outbox · the requests and auctions: ${baseUrl}/admin.html\n`);
