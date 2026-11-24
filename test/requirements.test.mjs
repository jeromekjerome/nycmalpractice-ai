import './test-settings.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from './runner.mjs';
import { calculateRefund } from '../auction.js';
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
