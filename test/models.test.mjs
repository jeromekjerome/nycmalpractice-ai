// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The model chains: where the names live, and what may change them.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from './runner.mjs';
import { hasPrice } from '../ai-budget.js';
import { capFor } from '../providers.js';
import { SMALL_JOBS, REPLY_JOBS } from '../measure/app.mjs';
import { chains, modelSettings } from '../model-settings.js';
import { providerOf } from '../model-registry.js';
import { DEFAULTS, LIMITS_MS, limitFor, DEFAULT_ASK_REPLY_DEADLINE_MS, replyReserveMs } from '../models.js';

test('the built-in chains come from one place, and with no chains saved they are the ones every job runs with', async () => {
  assert.deepEqual(DEFAULTS, {
    answer: ['gpt-6.1-terra', 'claude-haiku-5-5', 'gemini-3.5-flash-lite'],
    small: ['gpt-6-luna', 'claude-haiku-5-5', 'gemini-3.5-flash-lite'],
    embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
  });
  assert.ok(Object.isFrozen(DEFAULTS) && Object.values(DEFAULTS).every(Object.isFrozen));
  // The suite gives the settings no database, as for a site whose settings cannot be read.
  assert.deepEqual(await chains(), { answer: [...DEFAULTS.answer], small: [...DEFAULTS.small], source: 'defaults', override: null });
});

test('saved chains set what each job runs with, a chain of one model is a chain of one, and the embedding chain is no setting', async () => {
  // The small jobs' main model is one that is not the default, with the default fallbacks behind it.
  const saved = { answer: ['gpt-6.2-sol'], small: ['gpt-5.4-nano', 'gpt-6.1-terra', 'gpt-5.4-mini'] };
  const settings = modelSettings({ sqlClient: async () => [{ value: saved }] });
  const given = await settings.chains();
  assert.deepEqual(given, { ...saved, source: 'settings', override: null });
  assert.equal('embedding' in given, false);
  assert.deepEqual(DEFAULTS.embedding, ['text-embedding-3-small', 'text-embedding-3-large']);
});

test('every model in the chains was chosen by the owner, measured, priced, and is not one OpenAI retires on 14 January 2027', () => {
  const chosen = JSON.parse(readFileSync(new URL('../measure/chosen.json', import.meta.url), 'utf8'));
  assert.equal(chosen.by, 'owner');
  assert.deepEqual(DEFAULTS.answer, chosen.answer);
  assert.deepEqual(DEFAULTS.small, chosen.small);
  assert.ok(existsSync(new URL(`../${chosen.report}`, import.meta.url)), 'the report the choice was made from is in the repository');
  // The record says why. The report holds each model to a bar, and no small-job model passed every rule of it,
  // so a reader has to be told on what grounds one was chosen all the same.
  for (const chain of ['answer', 'small']) {
    assert.ok(typeof chosen.why?.[chain] === 'string' && chosen.why[chain].trim().length >= 80, `measure/chosen.json does not say why the ${chain} chain was chosen`);
  }
  // Only finished runs count. A run that was stopped part-way is kept beside them as <label>.partial.json, on this
  // machine only, and would otherwise vouch here for a model that the repository cannot show was measured.
  const finished = readdirSync(new URL('../measure/results/', import.meta.url)).filter(file => file.endsWith('.json') && !file.endsWith('.partial.json'));
  const runs = finished.map(file => JSON.parse(readFileSync(new URL(`../measure/results/${file}`, import.meta.url), 'utf8')));
  // The run files keep the measurement's own word for the small model, "aux".
  for (const model of chosen.answer) assert.ok(runs.some(run => run.mode !== 'small' && run.answer === model), `${model} was never measured as a reply model`);
  for (const model of chosen.small) assert.ok(runs.some(run => run.mode === 'small' && run.aux === model), `${model} was never measured as a small-job model`);
  for (const model of [...chosen.answer, ...chosen.small]) {
    assert.equal(hasPrice(model), true, `${model} has no price`);
    assert.doesNotMatch(model, /^gpt-4(?:o|\.1)/, `${model} is retired on 14 January 2027`);
  }
});

test('every model in the chains has a measured time limit for each job, within the cap for its kind, and any other model is given the cap', () => {
  // The jobs are the ones the callers give runJob, by the names the measurement records them under. This app has no
  // seminar, so no seminar score.
  const jobs = [...REPLY_JOBS, ...SMALL_JOBS].sort();
  assert.deepEqual(jobs, ['caseCard', 'classify', 'grade', 'leadScore', 'reply', 'rewrite']);
  for (const model of new Set([...DEFAULTS.answer, ...DEFAULTS.small])) {
    assert.ok(Object.hasOwn(LIMITS_MS, model), `${model} has no time limits`);
    assert.deepEqual(Object.keys(LIMITS_MS[model]).sort(), jobs, model);
    for (const job of jobs) {
      const limit = LIMITS_MS[model][job];
      // Twice a slowest tenth, rounded up to the next 100 ms, and never over the cap for the job's kind.
      assert.ok(Number.isInteger(limit) && limit > 0 && limit % 100 === 0 && limit <= capFor(job), `${model} ${job}: ${limit}`);
      assert.equal(limitFor(model, job), limit, `${model} ${job}`);
    }
  }
  // The other providers' candidates this app measured (the reply and small-job runs of plan 2) have limits for the jobs
  // their runs timed, and for no other: claude-haiku-5-5 and gemini-3.5-flash-lite were measured on replies and small
  // jobs, claude-sonnet-5-5 and gemini-3.8-flash on replies only.
  const timed = { 'claude-haiku-5-5': jobs, 'claude-sonnet-5-5': ['reply', 'rewrite'], 'gemini-3.8-flash': ['reply', 'rewrite'], 'gemini-3.5-flash-lite': jobs };
  for (const [model, jobsTimed] of Object.entries(timed)) {
    assert.ok(Object.hasOwn(LIMITS_MS, model), `${model} has no time limits`);
    assert.deepEqual(Object.keys(LIMITS_MS[model]).sort(), [...jobsTimed].sort(), model);
  }
  // Every limit on record is of the same kind: a whole number of 100 ms, within the cap for its job's kind.
  for (const [model, limitsOf] of Object.entries(LIMITS_MS)) {
    for (const [job, limit] of Object.entries(limitsOf)) {
      assert.ok(jobs.includes(job), `${model} has a limit for ${job}, which is no job of this app`);
      assert.ok(Number.isInteger(limit) && limit > 0 && limit % 100 === 0 && limit <= capFor(job), `${model} ${job}: ${limit}`);
    }
  }
  // A model the measurement has not timed here is given the cap for each job's kind, and so is a job a model was not
  // timed for: claude-opus-5-5 was left out of this app's measurement, and claude-sonnet-5-5 was not asked a small job.
  assert.equal(limitFor('gpt-6.2-sol', 'grade'), 8_000);
  assert.equal(limitFor('gpt-6.2-sol', 'rewrite'), 20_000);
  assert.equal(limitFor('claude-opus-5-5', 'reply'), 20_000);
  assert.equal(limitFor('claude-sonnet-5-5', 'grade'), 8_000);
  assert.ok(Object.isFrozen(LIMITS_MS) && Object.values(LIMITS_MS).every(Object.isFrozen));
  // The longest a visitor waits for a reply, which every model call of that reply shares.
  assert.equal(DEFAULT_ASK_REPLY_DEADLINE_MS, 45_000);
});

test("the reply's clock ends a tenth of the reply deadline before it, and never more than a second and a half before", () => {
  // The time left to the gate's checks in code when a step of the gate is cut off at the clock's end.
  assert.equal(replyReserveMs(DEFAULT_ASK_REPLY_DEADLINE_MS), 1_500);
  assert.equal(replyReserveMs(15_000), 1_500);
  assert.equal(replyReserveMs(12_000), 1_200);
  assert.equal(replyReserveMs(2_000), 200);
  assert.equal(replyReserveMs(800), 80);
});

test('the example settings and the readme name no model OpenAI retires, and no setting of the environment chooses a model', () => {
  // A copy of the example becomes somebody's settings. The chains are a setting kept in the database
  // (model-settings.js), the one source of truth, so the example's only OpenAI setting is the key.
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.deepEqual([...example.matchAll(/^#?\s*(OPENAI_\w+)=/gm)].map(match => match[1]), ['OPENAI_API_KEY']);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.deepEqual([...new Set(readme.match(/\bOPENAI_\w+/g))], ['OPENAI_API_KEY']);
  for (const [file, text] of [['.env.example', example], ['README.md', readme]]) {
    assert.doesNotMatch(text, /gpt-4(?:o|\.1)/, `${file} still names a model OpenAI retires on 14 January 2027`);
  }
});

test('ask.js, auction.js, courtlistener.js, server.js and operations.js name no model and ask model-settings.js for their chains as each job starts, and the gate and providers.js name none either', () => {
  const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  for (const file of ['ask.js', 'auction.js', 'courtlistener.js', 'server.js', 'operations.js', 'gatekeeper.js', 'providers.js', 'model-settings.js']) {
    assert.doesNotMatch(source(file), /['"](?:gpt-|text-embedding-)/, `${file} still names a model`);
  }
  for (const file of ['ask.js', 'auction.js', 'courtlistener.js', 'server.js', 'operations.js']) {
    assert.match(source(file), /import \{[^}]*\bchains\b[^}]*\} from '\.\/model-settings\.js'/, `${file} does not ask model-settings.js for their chains`);
    assert.match(source(file), /= await chains\(\);/, `${file} does not ask for its chains`);
  }
  // The gate and providers.js are given their chains by their callers.
  for (const file of ['gatekeeper.js', 'providers.js']) {
    assert.doesNotMatch(source(file), /from '\.\/(?:models|model-settings)\.js'/, `${file} reads chains of its own`);
  }
  // The old module that walked the chains is gone, and so are the old names of the chains.
  assert.equal(existsSync(new URL('../openaiModelFailover.js', import.meta.url)), false, 'openaiModelFailover.js is still there');
  assert.doesNotMatch(source('models.js'), /\b(?:ANSWER_MODELS|AUX_MODELS|EMBEDDING_MODELS)\b/, 'models.js still exports the old names of the chains');
});

// The names the privacy page gives each provider, as the label of its entry under "Third-Party Services".
const PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' };

// The entries of the privacy page's list of third-party services, as { label, text, links }, from the page's HTML.
function serviceEntries(html) {
  const list = html.split('<h2>Third-Party Services</h2>')[1]?.split('</ul>')[0] ?? '';
  return [...list.matchAll(/<li>\s*<strong>([^<]+)<\/strong>([\s\S]*?)<\/li>/g)].map(([, label, rest]) => ({
    label: label.trim(),
    text: rest.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    links: [...rest.matchAll(/href="(https:\/\/[^"]+)"/g)].map(([, href]) => href),
  }));
}

// The providers the page names as AI processors: an entry whose label is the provider's name (a note in brackets
// after it is allowed), says the visitor's conversation goes to it, and links to its privacy policy. Google Fonts
// is another service, and its entry names Google without being the AI provider's.
function namedProviders(html) {
  return Object.entries(PROVIDER_NAMES)
    .filter(([, name]) => serviceEntries(html).some(entry => entry.label.replace(/\s*\(.*\)$/, '') === name && /conversation/i.test(entry.text) && entry.links.length > 0))
    .map(([provider]) => provider);
}

test('the privacy page names, among its AI processors, the provider of every model in the default chains', () => {
  const page = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8');
  const wanted = new Set([...DEFAULTS.answer, ...DEFAULTS.small].map(model => providerOf(model)));
  assert.ok(wanted.size > 0 && [...wanted].every(provider => provider in PROVIDER_NAMES), `a default model has a provider the page has no name for: ${[...wanted]}`);
  const named = namedProviders(page);
  for (const provider of wanted) {
    assert.ok(named.includes(provider), `the default chains send visitors' conversations to ${PROVIDER_NAMES[provider]}, which the privacy page does not name among its AI processors`);
  }
});

test("the privacy page's check does not take Google Fonts for Google, or a mention for an entry, or an entry that does not say what is sent", () => {
  const entry = (label, body) => `<h2>Third-Party Services</h2><ul><li><strong>${label}</strong> ${body}</li></ul>`;
  const fonts = entry('Google Fonts', 'Supplies the typefaces. See <a href="https://policies.google.com/privacy">Google\'s Privacy Policy</a>.');
  assert.deepEqual(namedProviders(fonts), []);
  assert.deepEqual(namedProviders(entry('Anthropic', 'Gets your conversation. See <a href="https://www.anthropic.com/legal/privacy">its policy</a>.')), ['anthropic']);
  assert.deepEqual(namedProviders(entry('Google (Gemini)', 'Gets your conversation. See <a href="https://policies.google.com/privacy">its policy</a>.')), ['google']);
  assert.deepEqual(namedProviders(entry('Anthropic', 'Gets your conversation, with no policy to read.')), []);
  assert.deepEqual(namedProviders(entry('Anthropic', 'Gets what you type. See <a href="https://www.anthropic.com/legal/privacy">its policy</a>.')), []);
  assert.deepEqual(namedProviders('<h2>Other</h2><ul><li><strong>OpenAI</strong> your conversation <a href="https://openai.com/privacy">x</a></li></ul>'), []);
  // This page's entries before the second provider: a label with its colon, and the policy's address as plain text.
  assert.deepEqual(namedProviders(entry('OpenAI:', 'Your conversation messages are sent to OpenAI. Its privacy policy applies: openai.com/privacy')), []);
});
