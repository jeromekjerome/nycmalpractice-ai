// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The two small tools the live steps of the model measurement use: measure/ask-scorer.mjs puts one made-up conversation to
// the lead scorer many times, and measure/case-cards.mjs reads what a small-job model writes for people on the case cards and
// the lead previews of a recorded run. Both ask a model of any of the three providers behind the measurement's guard, with
// the measurement's stand-in database address, an estimate first and nothing sent without --yes.
//
// Nothing here reaches a network or a database: the app, the settings and the fetch are stand-ins. This file is the same in
// both apps.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from './runner.mjs';
import { MEASURE_DATABASE_URL, MODEL_HOSTS } from '../measure/guard-fetch.mjs';
import { CASES, parseScorerArgs, scorerEstimate, runScorer } from '../measure/ask-scorer.mjs';
import { parseCardsArgs, cardsEstimate, pointsAtTheLimit, runCaseCards } from '../measure/case-cards.mjs';
import { estimateAiCost } from '../ai-budget.js';
import { entryFor } from '../model-registry.js';

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const HOST_OF = { openai: 'api.openai.com', anthropic: 'api.anthropic.com', google: 'generativelanguage.googleapis.com' };
const URL_OF = { openai: 'https://api.openai.com/v1/chat/completions', anthropic: 'https://api.anthropic.com/v1/messages', google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' };

// What each provider's endpoint answers with, in its own shape, for the text a model wrote.
function answerFrom(provider, text, { input = 1000, output = 200 } = {}) {
  if (provider === 'anthropic') return json({ type: 'message', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: input, output_tokens: output } });
  return json({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });
}

const KEYS = { OPENAI_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2', GEMINI_API_KEY: 'k3' };

// A made-up settings object, never the process's own.
const settings = (over = {}) => ({ ...KEYS, ...over });

function capturingLog() {
  const lines = [];
  return { lines, log: (...parts) => lines.push(parts.join(' ')), text: () => lines.join('\n') };
}

// ─── The lead scorer ──────────────────────────────────────────────────────────

test('the lead scorer holds both apps\' made-up claims, each tagged with its app, and reads its arguments strictly', () => {
  assert.ok(['old-crash', 'recent-fall', 'too-late', 'in-time'].every(key => key in CASES));
  for (const chosen of Object.values(CASES)) {
    assert.ok(['nycinjury', 'nycmalpractice'].includes(chosen.app));
    assert.ok(chosen.history.length >= 4 && chosen.latest);
    assert.ok(chosen.history.every(([role, content]) => ['user', 'assistant'].includes(role) && content));
  }
  assert.equal(CASES['old-crash'].app, 'nycinjury');
  assert.equal(CASES['too-late'].app, 'nycmalpractice');
  assert.deepEqual(parseScorerArgs(['old-crash', '10', '--model', 'claude-haiku-5-5']), { caseKey: 'old-crash', times: 10, model: 'claude-haiku-5-5', yes: false });
  assert.equal(parseScorerArgs(['recent-fall', '1', '--yes', '--model', 'gemini-3.5-flash-lite']).yes, true);
  assert.throws(() => parseScorerArgs(['no-such-case', '3', '--model', 'claude-haiku-5-5']), /usage/);
  for (const times of ['0', '21', '2.5', 'ten']) assert.throws(() => parseScorerArgs(['old-crash', times, '--model', 'claude-haiku-5-5']), /times/);
  assert.throws(() => parseScorerArgs(['old-crash', '3']), /--model/);
  assert.throws(() => parseScorerArgs(['old-crash', '3', '--model']), /--model/);
  assert.throws(() => parseScorerArgs(['old-crash', '3', '--model', 'gemini-9-imaginary']), /not in the registry/);
  assert.throws(() => parseScorerArgs(['old-crash', '3', '--model', 'claude-haiku-5-5', '--fast']), /--fast/);
  // A model that is not a chat model is refused: a claim cannot be scored by an embedding.
  assert.throws(() => parseScorerArgs(['old-crash', '3', '--model', 'text-embedding-3-small']), /chat model/);
});

test('the lead scorer works out its estimate from the registry price of the model asked, whichever provider sells it, thinking room included', () => {
  // 2,000 tokens in, and 300 out plus the 2,000 of thinking room every adapter gives, a quarter on top, up to the cent.
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
  near(scorerEstimate(10, 'claude-haiku-5-5', estimateAiCost), 10 * (2000 * 0.10 + 2300 * 0.50) / 1e6 * 1.25);
  near(scorerEstimate(10, 'gemini-3.8-flash', estimateAiCost), 10 * (2000 * 0.75 + 2300 * 3.75) / 1e6 * 1.25);
  near(scorerEstimate(10, 'gpt-6-luna', estimateAiCost), 10 * (2000 * 0.10 + 2300 * 0.50) / 1e6 * 1.25);
  assert.ok(scorerEstimate(10, 'claude-opus-5-5', estimateAiCost) > scorerEstimate(10, 'claude-sonnet-5-5', estimateAiCost));
});

// A stand-in for what the tool needs of the app: its adapter (measure/app.mjs), the settings a run is given, the price
// table, the lead scorer, and the fetch that answers for the providers. Nothing of the app is loaded.
function scorerWorld({ app = 'nycinjury', verdicts = [] } = {}) {
  const world = { used: [], asked: [], sent: [], scored: [] };
  world.adapter = {
    APP: app,
    jobOf: () => 'leadScore',
    async useModels(models) { world.used.push(models); },
  };
  world.deps = {
    environmentFor: () => ({ DATABASE_URL: MEASURE_DATABASE_URL, NODE_ENV: 'test' }),
    loadAdapter: async () => world.adapter,
    loadPrice: async () => estimateAiCost,
    // The app's lead scorer: it asks the model chain it was given, the one model, through the global fetch, as the app does.
    loadScoreLead: async () => async (latest, history, type) => {
      world.scored.push({ latest, history, type });
      const model = world.used.at(-1).aux;
      const provider = entryFor(model).provider;
      const verdict = verdicts[world.scored.length - 1];
      const response = await fetch(URL_OF[provider], { method: 'POST', body: JSON.stringify({ model, messages: [] }) });
      const text = provider === 'anthropic' ? (await response.json()).content[0].text : (await response.json()).choices[0].message.content;
      const result = JSON.parse(text);
      return result.viable && result.score >= 55 && !verdict?.refuse ? { ...result, tier: 'hot', reserve: 400 } : null;
    },
    fetchImpl: async (url, init) => {
      const host = new URL(String(url)).hostname;
      const provider = Object.keys(HOST_OF).find(name => HOST_OF[name] === host);
      world.sent.push(host);
      const next = verdicts[world.sent.length - 1] ?? { viable: true, score: 80 };
      const text = JSON.stringify({ viable: next.viable ?? true, score: next.score ?? 80, confidence: 0.9, dimensions: { liability: 8, damages: 8, sol: next.sol ?? 8, evidence: 7, collectibility: 6 }, preview: 'A made-up claim.' });
      return answerFrom(provider, text, { input: 1500, output: 250 });
    },
  };
  return world;
}

for (const model of ['gpt-6-luna', 'claude-haiku-5-5', 'gemini-3.5-flash-lite']) {
  test(`the lead scorer asks ${model} through its own provider, prints what the model answered and what the app made of it, and costs the calls`, async () => {
    const provider = entryFor(model).provider;
    const world = scorerWorld({ verdicts: [{ viable: true, score: 80 }, { viable: false, score: 20 }, { viable: true, score: 90 }] });
    const out = capturingLog();
    const before = globalThis.fetch;
    const env = settings();
    const code = await runScorer({ argv: ['old-crash', '3', '--model', model, '--yes'], env, log: out.log, logError: out.log, deps: world.deps });
    assert.equal(code, 0, out.text());
    // The chain handed to the app is the one model, for both of its jobs, so that no other model can answer.
    assert.deepEqual(world.used, [{ answer: model, aux: model }]);
    assert.deepEqual([...new Set(world.sent)], [HOST_OF[provider]]);
    assert.equal(world.scored.length, 3);
    assert.equal(world.scored[0].type, 'auto');
    assert.equal(world.scored[0].history.length, 4);
    assert.equal(env.DATABASE_URL, MEASURE_DATABASE_URL);
    const lines = out.lines;
    assert.match(lines[0], new RegExp(`^nycinjury: the lead scorer on "old-crash", 3 time\\(s\\), small-job model ${model}\\. Estimated cost: under \\$0\\.0\\d\\.$`));
    assert.equal(lines[1], ' 1. the model: viable true, score 80, confidence 0.9 (liability 8, damages 8, sol 8, evidence 7, collectibility 6)');
    assert.equal(lines[2], '    the app:   a hot lead, reserve $400');
    assert.equal(lines[3], ' 2. the model: viable false, score 20, confidence 0.9 (liability 8, damages 8, sol 8, evidence 7, collectibility 6)');
    assert.equal(lines[4], '    the app:   no verdict');
    assert.equal(lines[7], '"old-crash": a lead in 2 of 3. Cost $' + estimateAiCostOf(model, 3) + ' over 3 call(s); failed 0; refused none.');
    assert.equal(globalThis.fetch, before, 'the global fetch is put back');
  });
}

// What three calls of 1,500 in and 250 out cost the model, to four places, as the tool prints them.
function estimateAiCostOf(model, calls) {
  return (calls * estimateAiCost(model, 1500, 250)).toFixed(4);
}

test('the lead scorer prints its estimate and stops without --yes, refuses another app\'s claim, and a model whose provider has no key, before anything is sent', async () => {
  const out = capturingLog();
  const world = scorerWorld();
  assert.equal(await runScorer({ argv: ['old-crash', '5', '--model', 'claude-sonnet-5-5'], env: settings(), log: out.log, logError: out.log, deps: world.deps }), 2);
  assert.match(out.lines[0], /Estimated cost: under \$0\.\d\d\./);
  assert.equal(out.lines[1], 'Nothing has been run. Add --yes to run it.');
  assert.deepEqual([world.used, world.sent, world.scored], [[], [], []]);

  // The other app's claim: said at once, with nothing sent and the app given no model.
  const other = capturingLog();
  const otherWorld = scorerWorld();
  assert.equal(await runScorer({ argv: ['too-late', '5', '--model', 'claude-sonnet-5-5', '--yes'], env: settings(), log: other.log, logError: other.log, deps: otherWorld.deps }), 1);
  assert.match(other.text(), /"too-late" is a case for nycmalpractice; this repository is nycinjury\./);
  assert.deepEqual([otherWorld.used, otherWorld.sent], [[], []]);

  // A key the model's provider needs and the settings lack.
  const keyless = capturingLog();
  assert.equal(await runScorer({ argv: ['old-crash', '5', '--model', 'claude-sonnet-5-5', '--yes'], env: settings({ ANTHROPIC_API_KEY: '' }), log: keyless.log, logError: keyless.log, deps: scorerWorld().deps }), 1);
  assert.match(keyless.text(), /ANTHROPIC_API_KEY is not set\. Run this with node --env-file=\.env from the repository root\./);
  assert.doesNotMatch(keyless.text(), /OPENAI_API_KEY/);
  // The settings the tool was given are never printed.
  assert.doesNotMatch([out, other, keyless].map(piece => piece.text()).join('\n'), /k1|k2|k3/);

  // Bad arguments say how the tool is used.
  const usage = capturingLog();
  assert.equal(await runScorer({ argv: ['old-crash'], env: settings(), log: usage.log, logError: usage.log, deps: scorerWorld().deps }), 1);
  assert.match(usage.text(), /usage: node --env-file=\.env measure\/ask-scorer\.mjs/);
});

test('the lead scorer is held to the three providers\' hosts: a request to any other is refused, and counted in what it prints', async () => {
  const world = scorerWorld();
  const askedLoadScore = world.deps.loadScoreLead;
  world.deps.loadScoreLead = async () => {
    const score = await askedLoadScore();
    return async (...args) => {
      await assert.rejects(fetch('https://www.courtlistener.com/api/rest/v4/search/?q=x'), /measure: refused a request to www\.courtlistener\.com/);
      await assert.rejects(fetch('https://ep-cool-name-123456.us-east-2.aws.neon.tech/sql', { method: 'POST', body: '{}' }), /refused a request to ep-cool-name/);
      return score(...args);
    };
  };
  const out = capturingLog();
  assert.equal(await runScorer({ argv: ['recent-fall', '1', '--model', 'gpt-6-luna', '--yes'], env: settings(), log: out.log, logError: out.log, deps: world.deps }), 0, out.text());
  assert.match(out.lines.at(-1), /refused www\.courtlistener\.com, ep-cool-name-123456\.us-east-2\.aws\.neon\.tech\.$/);
  assert.deepEqual([...new Set(world.sent)], ['api.openai.com']);
  assert.deepEqual([...MODEL_HOSTS].sort(), ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com']);
});

// ─── The case-card and lead-preview reader ────────────────────────────────────

test('the card reader reads its arguments strictly and counts a point at the limit as cut short', () => {
  assert.deepEqual(parseCardsArgs(['claude-haiku-5-5', 'providers-module']), { model: 'claude-haiku-5-5', label: 'providers-module', count: 6, yes: false });
  assert.deepEqual(parseCardsArgs(['gemini-3.5-flash-lite', 'small-luna-1', '--count', '3', '--yes']), { model: 'gemini-3.5-flash-lite', label: 'small-luna-1', count: 3, yes: true });
  assert.throws(() => parseCardsArgs(['claude-haiku-5-5']), /usage/);
  assert.throws(() => parseCardsArgs(['gemini-9-imaginary', 'providers-module']), /not in the registry/);
  assert.throws(() => parseCardsArgs(['claude-haiku-5-5', '../base']), /label/);
  for (const count of ['0', '21', '1.5', 'six']) assert.throws(() => parseCardsArgs(['claude-haiku-5-5', 'providers-module', '--count', count]), /--count/);
  assert.throws(() => parseCardsArgs(['claude-haiku-5-5', 'providers-module', '--count']), /--count/);
  assert.throws(() => parseCardsArgs(['claude-haiku-5-5', 'providers-module', '--fast']), /--fast/);
  // The app keeps at most 200 characters of a point and cuts a longer one, ending it with an ellipsis.
  assert.deepEqual(pointsAtTheLimit(['short', 'x'.repeat(200), `${'y'.repeat(150)}…`, 'z'.repeat(199)], 200), 2);
  assert.equal(pointsAtTheLimit([], 200), 0);
});

test('the card reader works out its estimate from the registry prices of the small-job model and of the run\'s reply model', () => {
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
  // For each turn replayed: the grader, the lead scorer and the case card, each at 4,000 in and 2,500 out (thinking room
  // included); and a rewrite by the run's own reply model for one turn in five, at 4,000 in and 3,000 out. A quarter on top.
  const turns = 40;
  const expected = (turns * 3 * (4000 * 0.30 + 2500 * 2.50) / 1e6 + Math.ceil(turns / 5) * (4000 * 1.00 + 3000 * 5.00) / 1e6) * 1.25;
  near(cardsEstimate({ turns, model: 'gemini-3.5-flash-lite', answer: 'gpt-6.1-terra', price: estimateAiCost }), expected);
  assert.ok(cardsEstimate({ turns, model: 'claude-sonnet-5-5', answer: 'gpt-6.1-terra', price: estimateAiCost }) > cardsEstimate({ turns, model: 'claude-haiku-5-5', answer: 'gpt-6.1-terra', price: estimateAiCost }));
});

// A recorded run and its packets, for three made-up visitors: a seminar student, who is no part of this, and two clients.
const VISITORS = [
  { key: 'rear-end', mode: 'client', caseType: 'auto', messages: ['one', 'two', 'three', 'four'] },
  { key: 'wet-floor', mode: 'client', caseType: 'slip', messages: ['one', 'two', 'three'] },
  { key: 'seminar', mode: 'professor', caseType: 'auto', messages: ['one', 'two', 'three'] },
];
const RUN = { app: 'nycinjury', label: 'providers-module', answer: 'gpt-6.1-terra', aux: 'gpt-6-luna', turns: VISITORS.flatMap(visitor => visitor.messages.map((_, i) => ({ visitor: visitor.key, turn: i + 1, served: `served ${visitor.key} ${i + 1}` }))) };
const PACKETS = Object.fromEntries(VISITORS.map(visitor => [visitor.key, visitor.messages.map(() => ({ type: visitor.caseType, cases: [] }))]));

function cardsWorld({ cardFor, previewFor } = {}) {
  const world = { used: [], replies: [], sent: [] };
  world.adapter = {
    APP: 'nycinjury',
    SEMINAR_MODES: ['professor'],
    SIDE_JOBS_FROM_TURN: { leadScore: 2, caseCard: 3 },
    jobOf: () => 'caseCard',
    recordedFor: ({ type, cases, draft }) => ({ piType: type, cases, draft }),
    stateFor: () => null,
    async useModels(models) { world.used.push(models); },
    async reply(args) {
      world.replies.push(args);
      const model = world.used.at(-1).aux;
      const provider = entryFor(model).provider;
      await fetch(URL_OF[provider], { method: 'POST', body: JSON.stringify({ model, messages: [] }) });
      console.log('an app line that the tool keeps quiet');
      const turn = args.history.length / 2 + 1;
      return { answer: 'x', caseAnalysis: turn >= 3 ? cardFor(args, world.replies.length) : null, leadScore: previewFor(args, world.replies.length) };
    },
  };
  world.deps = {
    environmentFor: () => ({ DATABASE_URL: MEASURE_DATABASE_URL, NODE_ENV: 'test' }),
    loadAdapter: async () => world.adapter,
    loadPrice: async () => estimateAiCost,
    loadVisitors: async () => VISITORS,
    readJson: file => (file === 'results/providers-module.json' ? structuredClone(RUN) : file === 'packets.json' ? PACKETS : (() => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); })()),
    fetchImpl: async (url) => {
      const host = new URL(String(url)).hostname;
      world.sent.push(host);
      return answerFrom(Object.keys(HOST_OF).find(name => HOST_OF[name] === host), '{}', { input: 3000, output: 400 });
    },
  };
  return world;
}

test('the card reader replays the turns of a recorded run with the small-job model of any provider, and prints the first cards\' points and lead previews with their lengths', async () => {
  const point = (n, length) => `${n}`.repeat(1).padEnd(length, 'p');
  const world = cardsWorld({
    cardFor: (args, n) => ({ strengths: [point('s', 80), n % 2 ? point('t', 200) : point('t', 120)], weaknesses: [`${'w'.repeat(150)}…`], solNote: 'Three years under CPLR 214.' }),
    previewFor: (args, n) => (n % 3 === 0 ? null : { tier: 'warm', preview: `A claim, ${n}.` }),
  });
  const out = capturingLog();
  const savedLog = console.log;
  const code = await runCaseCards({ argv: ['claude-haiku-5-5', 'providers-module', '--count', '3', '--yes'], env: settings(), log: out.log, logError: out.log, deps: world.deps });
  assert.equal(code, 0, out.text());
  assert.equal(console.log, savedLog, 'the console is put back');
  // The run's own reply model writes any rewrite; the small model asked is the small-job chain.
  assert.deepEqual(world.used, [{ answer: 'gpt-6.1-terra', aux: 'claude-haiku-5-5' }]);
  assert.deepEqual([...new Set(world.sent)], ['api.anthropic.com']);
  // Seminar turns are no part of it; the client turns from the second are replayed, in the run's order, with its replies.
  assert.deepEqual(world.replies.slice(0, 3).map(args => [args.sessionId, args.question, args.history.length]), [['cards-rear-end', 'two', 2], ['cards-rear-end', 'three', 4], ['cards-rear-end', 'four', 6]]);
  assert.deepEqual(world.replies[0].recorded, { piType: 'auto', cases: [], draft: 'served rear-end 2' });
  assert.deepEqual(world.replies[0].history, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'served rear-end 1' }]);
  assert.equal(world.replies.every(args => args.allowLeadScoring === true && args.mode === 'client'), true);
  assert.equal(world.replies.every(args => args.sessionId !== 'cards-seminar'), true);
  // It stops once it has the cards and previews it was asked for: three of each.
  const text = out.text();
  assert.doesNotMatch(text, /an app line that the tool keeps quiet/);
  assert.match(out.lines[0], /^nycinjury: case cards and lead previews, small-job model claude-haiku-5-5, on the conversations of providers-module \(replies by gpt-6\.1-terra\)\. Estimated cost: under \$0\.\d\d\.$/);
  const cards = out.lines.filter(line => /^case card \d+ /.test(line));
  assert.equal(cards.length, 3);
  assert.match(text, /^case card 1 \(rear-end:3\)$/m);
  assert.match(text, /^  strength \(80\): s/m);
  assert.match(text, /^  weakness \(151\): w+…$/m);
  assert.match(text, /^  deadline note \(27\): Three years under CPLR 214\.$/m);
  // This app's card has no complexity estimate, and gets no line for one.
  assert.doesNotMatch(text, /complexity/);
  const previews = out.lines.filter(line => /^lead preview \d+ /.test(line));
  assert.equal(previews.length, 3);
  assert.match(text, /^lead preview 1 \(rear-end:2\), 11 characters: A claim, 1\.$/m);
  assert.match(text, /^lead preview 3 \(wet-floor:2\), 11 characters: A claim, 4\.$/m);
  // The summary: how many cards, points and previews, how long they are, and how many points come back cut at the limit
  // (a point of 200 characters, or one the app cut short and ended with an ellipsis): 1 + 2 + 2 of the nine.
  assert.match(text, /^claude-haiku-5-5: 3 case cards \(0 due and missing\), 9 points, middle length 151, longest 200\.$/m);
  assert.match(text, /^Points at the limit \(cut short\): 5 of 9 points, 3 of 3 cards show at least one cut\.$/m);
  assert.match(text, /^Lead previews: 3, middle length 11, longest 11\.$/m);
  assert.match(out.lines.at(-1), /^Cost \$\d\.\d{4} over \d+ call\(s\); failed 0; refused none\.$/);
});

test("the card reader prints the sister app's deadline warning with its length, and its complexity estimate after it, saying so when a card has none", async () => {
  // NYCMalpractice.ai's case card (normalizeCaseAnalysis in its ask.js) calls the deadline note solWarning, and keeps 300
  // characters of it, as this app keeps of solNote. It also carries a complexity estimate: { level, reason }, or null when
  // too little is known.
  const warning = 'A notice of claim within 90 days may apply, since the surgery was at a city hospital.';
  const cutWarning = `${'A federal claim within 2 years may apply. '.repeat(8).slice(0, 299)}…`;
  const reason = 'Expert testimony on the standard of care.';
  const strength = 'A sponge was found on a scan.';
  const weakness = 'The surgery was two years ago.';
  // The cards come with the replies to the first visitor's third and fourth turns (replies 2 and 3), and the second's third.
  const world = cardsWorld({
    cardFor: (args, n) => ({
      score: 6, verdict: 'moderate', strengths: [strength], weaknesses: [weakness],
      complexityEstimate: n === 2 ? null : { level: 'High', reason },
      solWarning: n === 3 ? cutWarning : warning,
    }),
    previewFor: () => null,
  });
  const out = capturingLog();
  const code = await runCaseCards({ argv: ['claude-haiku-5-5', 'providers-module', '--count', '2', '--yes'], env: settings(), log: out.log, logError: out.log, deps: world.deps });
  assert.equal(code, 0, out.text());
  // Each card's lines: its points, its deadline note with its length, and then a line for the complexity estimate.
  assert.deepEqual(out.lines.slice(1, 11), [
    'case card 1 (rear-end:3)',
    `  strength (${strength.length}): ${strength}`,
    `  weakness (${weakness.length}): ${weakness}`,
    `  deadline note (${warning.length}): ${warning}`,
    '  complexity: none given',
    'case card 2 (rear-end:4)',
    `  strength (${strength.length}): ${strength}`,
    `  weakness (${weakness.length}): ${weakness}`,
    `  deadline note (300): ${cutWarning}`,
    `  complexity High (${reason.length}): ${reason}`,
  ]);
  // A deadline warning the app cut at its 300 characters counts as a cut, as a note of this app's does.
  assert.ok(out.lines.includes('Points at the limit (cut short): 0 of 4 points, 1 of 2 cards show at least one cut.'), out.text());
});

test('the card reader prints its estimate and stops without --yes, and refuses a run it cannot read or one of another app, before anything is sent', async () => {
  const world = cardsWorld({ cardFor: () => null, previewFor: () => null });
  const out = capturingLog();
  assert.equal(await runCaseCards({ argv: ['gemini-3.5-flash-lite', 'providers-module'], env: settings(), log: out.log, logError: out.log, deps: world.deps }), 2);
  assert.match(out.lines[0], /Estimated cost: under \$\d\.\d\d\./);
  assert.equal(out.lines[1], 'Nothing has been run. Add --yes to run it.');
  assert.deepEqual([world.used, world.sent, world.replies], [[], [], []]);

  const missing = capturingLog();
  assert.equal(await runCaseCards({ argv: ['claude-haiku-5-5', 'no-such-run', '--yes'], env: settings(), log: missing.log, logError: missing.log, deps: world.deps }), 1);
  assert.match(missing.text(), /there is no run named no-such-run in measure\/results/);

  const otherApp = cardsWorld({ cardFor: () => null, previewFor: () => null });
  otherApp.deps.readJson = file => (file === 'packets.json' ? PACKETS : { ...RUN, app: 'nycmalpractice' });
  const other = capturingLog();
  assert.equal(await runCaseCards({ argv: ['claude-haiku-5-5', 'providers-module', '--yes'], env: settings(), log: other.log, logError: other.log, deps: otherApp.deps }), 1);
  assert.match(other.text(), /providers-module was run on nycmalpractice, not nycinjury/);
  assert.deepEqual(otherApp.used, []);

  // Keys: the small-job model's provider and the run's reply model's, and no other.
  const keyless = capturingLog();
  assert.equal(await runCaseCards({ argv: ['gemini-3.5-flash-lite', 'providers-module', '--yes'], env: settings({ GEMINI_API_KEY: '' }), log: keyless.log, logError: keyless.log, deps: cardsWorld({ cardFor: () => null, previewFor: () => null }).deps }), 1);
  assert.match(keyless.text(), /GEMINI_API_KEY is not set/);
  const noReplyKey = capturingLog();
  assert.equal(await runCaseCards({ argv: ['gemini-3.5-flash-lite', 'providers-module', '--yes'], env: settings({ OPENAI_API_KEY: '' }), log: noReplyKey.log, logError: noReplyKey.log, deps: cardsWorld({ cardFor: () => null, previewFor: () => null }).deps }), 1);
  assert.match(noReplyKey.text(), /OPENAI_API_KEY is not set/);
});

test('both tools are shared, ask no model but through the registry, and open no database', () => {
  for (const file of ['ask-scorer.mjs', 'case-cards.mjs']) {
    const source = readFileSync(new URL(`../measure/${file}`, import.meta.url), 'utf8');
    // Nothing of the app is imported when the file is: the settings and the guard come first.
    assert.doesNotMatch(source, /^import .* from '\.\.\/(ai-budget|auction|ask|db|server|providers|model-settings)\.js'/m, `${file} imports the app before the guard`);
    assert.match(source, /installGuard\(\{ allowHosts: \[\.\.\.MODEL_HOSTS\]/);
    assert.doesNotMatch(source, /api\.openai\.com|process\.env\.OPENAI_API_KEY/, `${file} names one provider`);
    assert.doesNotMatch(source, /courtlistener/i, `${file} may reach CourtListener`);
  }
});
