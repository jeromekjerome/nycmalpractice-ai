// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

import './test-settings.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { test } from './runner.mjs';
import { calculateRefund } from '../auction.js';
import { enforceDeterministicGate } from '../gatekeeper.js';
import { CONTACT_CONSENT_TEXT, MAX_FIRMS_PER_LEAD } from '../site.js';

const home = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('a refund depends only on recent declines and the kind of lead', () => {
  assert.equal(calculateRefund.length, 3);
  assert.equal(calculateRefund({ cold: 0, auction: 0 }, false, 25), 25);
  assert.equal(calculateRefund({ cold: 3, auction: 0 }, false, 25), 12.5);
  assert.equal(calculateRefund({ cold: 0, auction: 0 }, true, 100), 50);
  assert.equal(calculateRefund({ cold: 0, auction: 1 }, true, 100), 25);
  assert.equal(calculateRefund({ cold: 0, auction: 2 }, true, 100), 0);
  const code = readFileSync(new URL('../auction.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /retained_at|case_outcome|contingency|fee_percent/i);
});

const NOTICE = ['Nothing goes to a law firm unless you ask and agree.', 'If you do, participating New York firms, which pay to take part, may see an AI summary and rating of your situation, without your name or contact details. Up to three of them, by highest bid or at random, then get your details and this conversation and may contact you.', "We check only that a firm's supervising attorney is registered in New York. We do not recommend any lawyer, and being chosen does not mean a firm is the best or right one for you."];

test('the notice sits in the message card above the box', () => {
  const card = home.slice(home.indexOf('interaction-card'));
  const notice = card.indexOf('id="visitorNotice"');
  assert.ok(notice > -1 && notice < card.indexOf('<textarea'));
  for (const sentence of NOTICE) assert.ok(card.slice(notice, card.indexOf('<textarea')).includes(sentence), sentence);
});
test('the consent box states the summary, the payment and the contact sharing', () => {
  assert.ok(home.includes(CONTACT_CONSENT_TEXT));
  assert.ok(CONTACT_CONSENT_TEXT.startsWith('I agree that NYCMalpractice.ai may show an AI-written summary and rating'));
  for (const words of ['AI-written summary and rating', 'without my name or contact details', 'pay to take part', 'may bid', 'up to three licensed New York attorneys']) assert.ok(CONTACT_CONSENT_TEXT.includes(words), words);
});
test('the words on how a firm is chosen match the code', () => {
  assert.equal(MAX_FIRMS_PER_LEAD, 3);
  assert.ok(NOTICE[1].includes('Up to three of them, by highest bid or at random'));
  const code = readFileSync(new URL('../auction.js', import.meta.url), 'utf8');
  assert.match(code, /ORDER BY MAX\(amount\) DESC/);
  for (const name of ['deliverColdLead', 'deliverLeadByHand']) {
    const start = code.indexOf(`export async function ${name}`);
    assert.match(code.slice(start, code.indexOf('\n}\n', start)), /shuffled\(/, name);
  }
});

const VISITOR_PAGES = ['index', 'about', 'disclaimer', 'privacy', 'terms'];
const pageText = name => readFileSync(new URL(`../public/${name}.html`, import.meta.url), 'utf8');
const RETIRED = [/get matched/i, /match you with/i, /qualified (?:New York|NYC)[^.<]{0,40}(?:attorney|lawyer)/i, /connected with a qualified attorney/i, /connect qualified leads/i, /Firms pay us for these referrals/i, /attorney referral/i, /that referral is not/i, /understand their rights/i, /like a referral/i];

test('no visitor page uses the retired wording', () => {
  for (const name of ['index', 'about', 'disclaimer', 'privacy']) for (const word of RETIRED) assert.doesNotMatch(pageText(name), word, name);
  const script = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
  const ask = readFileSync(new URL('../ask.js', import.meta.url), 'utf8');
  for (const word of RETIRED) { assert.doesNotMatch(script, word); assert.doesNotMatch(ask, word); }
});
test('the notice and the About page say firms pay, what is checked and what being chosen means', () => {
  for (const text of [home, pageText('about')]) {
    assert.match(text, /pay to take part/);
    assert.match(text, /check only that/);
    assert.match(text, /best or right one for you/);
  }
});
test('the visitor pages say the site is not a law firm and gives no legal advice', () => {
  for (const name of VISITOR_PAGES) { assert.match(pageText(name), /not a law firm/i, name); assert.match(pageText(name), /legal advice/i, name); }
  for (const name of ['index', 'privacy', 'terms']) assert.ok(pageText(name).includes('NYCMalpractice.ai. Not a law firm. Not legal advice.'), name);
});

const BLOCK = ['I can connect you with a top New York malpractice attorney.', 'Our vetted firms can help.', 'This is the best lawyer for your case.', "We'll match you with the right firm.", 'Would you like me to connect you with a top New York personal injury attorney?', 'Would you like to be connected with one of our vetted firms?', 'Shall I send your request to the best lawyer for your case?', 'Can I connect you with a trusted malpractice firm?', 'The attorneys on our platform are vetted.', 'I recommend that attorney.', 'I highly recommend that firm.'];
const PASS = ['We do not recommend any lawyer.', 'You should speak with an attorney.', 'Consult a qualified attorney.', 'A qualified expert must review the case.', 'Being chosen does not mean a firm is the best or right one for you.', 'The best next step is to speak with an attorney soon.', 'On top of that, an attorney can check the deadline.', 'Have an attorney check this deadline soon.', 'It is best to call an attorney soon.', 'You have the right to an attorney.', 'It is best to see a lawyer.', 'I recommend that you see an attorney.', 'We recommend that you call a lawyer today.', 'Only a licensed attorney is qualified to give legal advice.', 'Speak with the experienced attorney you choose.', 'Would you like to speak with an attorney?', 'Would you like me to send your request to a participating New York law firm?'];

async function violated(text, mode, id) {
  const report = await enforceDeterministicGate({ required_checks: [], prohibited_checks: [] }, text, 5, mode, []);
  return report.prohibited_checks.find(check => check.id === id)?.violated === true;
}

test('the reply check blocks vouching and passes ordinary advice', async () => {
  for (const [mode, id] of [['personal', 'PROH-MM-04'], ['estate', 'PROH-MME-04']]) {
    for (const text of BLOCK) assert.equal(await violated(text, mode, id), true, `${mode}: ${text}`);
    for (const text of PASS) assert.equal(await violated(text, mode, id), false, `${mode}: ${text}`);
  }
});

test('the About page says who receives the details', () => {
  const about = pageText('about');
  assert.ok(about.includes('firms bid on a summary written to leave out your name and contact details. The winning firm receives them; if it declines or does not answer, up to two more firms chosen at random may.'));
  assert.ok(!about.includes('only the winning firm'));
  assert.ok(!about.includes('has no name or contact details'));
});

test('every requirement names real sources, files and tests', () => {
  const law = JSON.parse(readFileSync(new URL('../rubrics/ny_malpractice_current_law.json', import.meta.url), 'utf8'));
  const sourceIds = new Set(law.sources.map(source => source.id));
  const written = readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.test.mjs')).map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');
  assert.ok(law.requirements.length >= 9);
  for (const item of law.requirements) {
    assert.ok(item.sources.length && item.files.length && item.tests.length, item.id);
    for (const id of item.sources) assert.ok(sourceIds.has(id), `${item.id} source ${id}`);
    for (const file of item.files) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${item.id} file ${file}`);
    for (const name of item.tests) assert.ok(written.includes(`test('${name}'`) || written.includes(`test("${name}"`), `${item.id} test ${name}`);
  }
});
