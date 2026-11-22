// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// What is this app's own in the model measurement: the adapter the tools reach the app through (measure/app.mjs),
// the synthetic visitors and the drafts that are wrong on purpose (measure/visitors.mjs). The tools themselves are
// tested in measure.test.mjs, which is the same file in both apps. How each model call is told by its job is
// tested in app.test.mjs, beside the prompts it is told by, and here in the request shape of each provider.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { MEASURE_DATABASE_URL } from '../measure/guard-fetch.mjs';
import { VISITORS, KNOWN_BAD } from '../measure/visitors.mjs';
import * as app from '../measure/app.mjs';
import { evaluateAndRemediateDraft, loadRubric } from '../gatekeeper.js';
import { PERSONAS, CASES } from '../demo/synthetic-data.mjs';
import { LIMITS_MS, DEFAULT_ASK_REPLY_DEADLINE_MS, replyReserveMs } from '../models.js';

test("the measurement reaches the app through one file, in this app's words, and loads the app only in a measurement run", async () => {
  assert.equal(app.APP, 'nycmalpractice');
  assert.deepEqual(app.SEMINAR_MODES, []);
  assert.deepEqual(app.recordedFor({ type: 'dental', cases: [] }), { caseType: 'dental', cases: [] });
  assert.deepEqual(app.recordedFor({ type: 'dental', cases: [{ caseName: 'A' }], draft: '' }), { caseType: 'dental', cases: [{ caseName: 'A' }], draft: '' });
  // This app keeps no state between a visitor's turns.
  assert.equal(app.stateFor('personal'), null);
  assert.equal(app.stateFor('estate'), null);
  assert.deepEqual(app.SIDE_JOBS_FROM_TURN, { leadScore: 2, caseCard: 3 });
  // Every visitor to be read in full is one of ours, and both kinds of visitor are among them.
  assert.equal(app.SAMPLE_VISITORS.length, 3);
  for (const key of app.SAMPLE_VISITORS) assert.ok(VISITORS.some(visitor => visitor.key === key), key);
  assert.deepEqual([...new Set(app.SAMPLE_VISITORS.map(key => VISITORS.find(visitor => visitor.key === key).mode))].sort(), ['estate', 'personal']);
  assert.deepEqual([...app.SMALL_JOBS, ...app.REPLY_JOBS].length, new Set([...app.SMALL_JOBS, ...app.REPLY_JOBS]).size);
  // This process has the tests' database address, not the measurement's, so the app is not to be loaded from here.
  assert.notEqual(process.env.DATABASE_URL, MEASURE_DATABASE_URL);
  for (const call of [() => app.reply({}), () => app.find([], 'x'), () => app.classify([], 'x')]) {
    await assert.rejects(call(), /measure: the app is loaded only in a measurement run/);
  }
});

test("each measured turn is given the clock a visitor's reply gets: the reply deadline less its reserve, from its start, and this app's limit for each model and job", async () => {
  // Outside a measurement run no clock is made either, since making one loads the app.
  await assert.rejects(app.clockForTurn(), /measure: the app is loaded only in a measurement run/);
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = MEASURE_DATABASE_URL;
  try {
    const before = Date.now();
    const clock = await app.clockForTurn();
    const left = clock.remaining();
    const due = DEFAULT_ASK_REPLY_DEADLINE_MS - replyReserveMs(DEFAULT_ASK_REPLY_DEADLINE_MS);
    assert.ok(left <= due && left >= due - (Date.now() - before), `${left} ms left`);
    for (const [model, jobs] of Object.entries(LIMITS_MS)) {
      for (const [job, limit] of Object.entries(jobs)) assert.equal(clock.limitFor(model, job), limit, `${model} ${job}`);
    }
    // Each turn has its own: a provider that failed in one turn keeps its place in the next.
    clock.demote('openai');
    assert.equal((await app.clockForTurn()).demoted('openai'), false);
  } finally {
    process.env.DATABASE_URL = saved;
  }
});

test("the runner's two models become the app's chains, one model each, the small model under the app's own word for it, and only in a measurement run", async () => {
  const { chains, configureModelSettings } = await import('../model-settings.js');
  const models = { answer: 'gpt-6.2-sol', aux: 'gpt-5.4-nano' };
  await assert.rejects(app.useModels(models), /measure: the app is loaded only in a measurement run/);
  assert.equal((await chains()).source, 'defaults');
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = MEASURE_DATABASE_URL;
  try {
    await app.useModels(models);
    assert.deepEqual(await chains(), { answer: ['gpt-6.2-sol'], small: ['gpt-5.4-nano'], source: 'measurement', override: null });
    // A chain of several, in the order they are tried, is handed over whole.
    await app.useModels({ answer: ['gpt-6.1-terra', 'claude-haiku-5-5'], aux: ['gpt-6-luna', 'claude-haiku-5-5', 'gemini-3.5-flash-lite'] });
    assert.deepEqual(await chains(), { answer: ['gpt-6.1-terra', 'claude-haiku-5-5'], small: ['gpt-6-luna', 'claude-haiku-5-5', 'gemini-3.5-flash-lite'], source: 'measurement', override: null });
  } finally {
    process.env.DATABASE_URL = saved;
    // The suite's own settings again: no database, and the built-in chains.
    configureModelSettings({ sqlClient: null });
  }
  assert.equal((await chains()).source, 'defaults');
});

test("the synthetic visitors are the demo's personas and one seeded family, in both modes, and hold nothing but what they say", () => {
  assert.equal(VISITORS.length, 6);
  assert.equal(new Set(VISITORS.map(v => v.key)).size, 6);
  assert.deepEqual(VISITORS.slice(0, 5).map(v => v.key), PERSONAS.map(persona => persona.key));
  assert.deepEqual(VISITORS[5], {
    key: 'pressure-ulcers', mode: 'estate', caseType: 'nursing_home',
    messages: CASES.find(seeded => seeded.key === 'pressure-ulcers').history.filter(([role]) => role === 'user').map(([, text]) => text),
  });
  assert.deepEqual([...new Set(VISITORS.map(v => v.mode))].sort(), ['estate', 'personal']);
  assert.equal(VISITORS.filter(v => v.mode === 'estate').length, 2);
  assert.equal(VISITORS.reduce((turns, v) => turns + v.messages.length, 0), 24);
  for (const visitor of VISITORS) {
    // The demo's made-up names, numbers and addresses stay in the demo: a visitor here is a key, a mode, a case
    // type and what is said.
    assert.deepEqual(Object.keys(visitor).sort(), ['caseType', 'key', 'messages', 'mode'], visitor.key);
    assert.ok(visitor.messages.length >= 3 && visitor.messages.length <= 5, visitor.key);
    for (const message of visitor.messages) {
      assert.ok(typeof message === 'string' && message.length > 0 && message.length < 600, visitor.key);
      assert.doesNotMatch(message, /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|@[a-z0-9-]+\.[a-z]{2,}/i, `${visitor.key} holds a phone number or an address`);
    }
  }
});

test('each known-bad draft belongs to a visitor and a turn, passes the checks code can make, and breaks one rule only a model can judge', async () => {
  // One for each rule the two rubrics leave to a model.
  const modelJudged = ['personal', 'estate'].flatMap(mode => {
    const rubric = loadRubric(mode);
    return [...rubric.required_criteria, ...rubric.prohibited_criteria].filter(criterion => !criterion.deterministic_check).map(criterion => criterion.id);
  });
  assert.deepEqual(KNOWN_BAD.map(d => d.breaks).sort(), [...modelJudged].sort());
  assert.deepEqual([...modelJudged].sort(), ['PROH-MM-03', 'PROH-MME-03', 'REQ-MM-01', 'REQ-MM-02', 'REQ-MME-01', 'REQ-MME-02']);
  assert.equal(new Set(KNOWN_BAD.map(d => d.key)).size, KNOWN_BAD.length);
  for (const bad of KNOWN_BAD) {
    const visitor = VISITORS.find(v => v.key === bad.visitor);
    assert.ok(visitor && bad.turn >= 1 && bad.turn <= visitor.messages.length, bad.key);
    assert.doesNotMatch(bad.draft, /\$\s?\d|\bv\.\s/, `${bad.key} would be caught by code`);
    assert.match(bad.draft, /This is general information, not legal advice\./, bad.key);
    // The rule it breaks is in the rubric its visitor's replies are graded on.
    const rubric = loadRubric(visitor.mode);
    const rule = [...rubric.required_criteria, ...rubric.prohibited_criteria].find(criterion => criterion.id === bad.breaks);
    assert.ok(rule, `${bad.key}: ${bad.breaks} is not a rule of the ${visitor.mode} rubric`);
    assert.equal(rule.deterministic_check, undefined, `${bad.key}: ${bad.breaks} is checked in code`);
    // And the gate's own code, with no model behind it, finds nothing wrong with the draft.
    const { evaluation } = await evaluateAndRemediateDraft({ draftText: bad.draft, turn: bad.turn, mode: visitor.mode, retrievedCases: [], deterministicOnly: true });
    assert.equal(evaluation.first_pass_compliant, true, `${bad.key} is caught by code`);
    assert.equal(evaluation.attempts[0].draft_text, bad.draft, bad.key);
  }
});

// A request as each provider's adapter sends it, for the job's own messages: the adapters are given a client that
// keeps the body and answers with nothing, so that what jobOf reads is what really leaves the app.
async function sentTo(provider, job, messages, { system } = {}) {
  const [{ anthropicAdapter }, { googleAdapter }, { openaiAdapter }] = await Promise.all([import('../provider-anthropic.js'), import('../provider-google.js'), import('../provider-openai.js')]);
  let body = null;
  const keep = async (request) => { body = request; return { choices: [{ message: { content: '' } }], content: [], usage: {} }; };
  const adapter = {
    openai: openaiAdapter({ chat: { completions: { create: keep } } }),
    anthropic: anthropicAdapter({ messages: { create: keep } }),
    google: googleAdapter({ chat: { completions: { create: keep } } }),
  }[provider];
  await adapter.call({ model: 'm', entry: {}, job, system, messages, json: job !== 'reply' && job !== 'rewrite', maxTokens: 100 });
  return body;
}

test("the measurement tells each model call by its job from each provider's own request shape, where Anthropic carries the system text apart", async () => {
  // Each job's messages open as this app's prompts do (ask.js, auction.js, courtlistener.js and the gate).
  const small = {
    classify: [{ role: 'user', content: 'Classify this NYC malpractice inquiry into one category.\n\nCategories: ...' }],
    leadScore: [{ role: 'user', content: 'You are a NYC medical malpractice case evaluator for a law firm lead marketplace.' }],
    caseCard: [{ role: 'user', content: 'You are a NYC medical malpractice case analyst evaluating the position of the injured patient.' }],
    // The grader's prompt is a system message: Anthropic's adapter moves it to the top-level `system`, and Google's
    // keeps it as the first message.
    grade: [{ role: 'system', content: 'You are an uncompromising AI Compliance Gatekeeper and Enablement Coach for a legal site.' }, { role: 'user', content: 'The draft: ...' }],
    reply: [{ role: 'system', content: 'You are an expert NYC medical malpractice advisor.' }, { role: 'user', content: 'What is the deadline?' }],
    rewrite: [{ role: 'system', content: 'You are an expert NYC medical malpractice advisor.' }, { role: 'user', content: 'What is the deadline?' }, { role: 'assistant', content: 'The draft.' }, { role: 'system', content: 'COMPLIANCE GATEKEEPER — AUTOMATIC REMEDIATION\nRewrite it.' }],
  };
  assert.deepEqual(Object.keys(small).sort(), [...app.SMALL_JOBS, ...app.REPLY_JOBS].sort());
  for (const provider of ['openai', 'anthropic', 'google']) {
    for (const [job, messages] of Object.entries(small)) assert.equal(app.jobOf(await sentTo(provider, job, messages)), job, `${provider} ${job}`);
  }
  // Anthropic: the grader's opening is the top-level system text, and its messages hold the draft alone.
  const anthropicGrade = await sentTo('anthropic', 'grade', small.grade);
  assert.match(anthropicGrade.system, /^You are an uncompromising AI Compliance Gatekeeper/);
  assert.equal(anthropicGrade.messages[0].content, 'The draft: ...');
  // The system text may also come apart from the job's own `system` argument, ahead of the messages.
  assert.equal(app.jobOf(await sentTo('anthropic', 'grade', [{ role: 'user', content: 'The draft: ...' }], { system: 'You are an uncompromising AI Compliance Gatekeeper and Enablement Coach.' })), 'grade');
  // The rewrite's instruction is the last message in every shape, as a user turn for Anthropic and Google.
  assert.equal((await sentTo('anthropic', 'rewrite', small.rewrite)).messages.at(-1).role, 'user');
  assert.equal((await sentTo('google', 'rewrite', small.rewrite)).messages.at(-1).role, 'user');
  // A request that is none of these is the reply, and a system text given as blocks is read as its text.
  assert.equal(app.jobOf({ system: [{ type: 'text', text: 'You are a NYC medical malpractice case analyst' }], messages: [] }), 'caseCard');
  assert.equal(app.jobOf({ system: 'Be brief.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] }), 'reply');
  assert.equal(app.jobOf({}), 'reply');
});
