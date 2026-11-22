// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The chains as a setting (model-settings.js): what a save is checked against, the row the app reads with the
// built-in chains behind it, the override, and the chains a measurement run gives the app. A database kept in memory
// stands in for the tables app_settings and model_measurements: it runs the statements the module sends and refuses
// any other. Nothing here reaches a network or a database.
//
// This file is the same in both apps. checkChains is shown stand-in models of three stand-in providers, with a
// registry of their own; the rest uses the registry both apps share and this app's built-in chains (models.js).
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { test } from './runner.mjs';
import { checkChains, checkMeasurementRows, modelSettings, KEY_NAMES } from '../model-settings.js';
import { MEASURE_DATABASE_URL } from '../measure-address.js';
import { DEFAULTS } from '../models.js';
import { entryFor } from '../model-registry.js';
import { modelsOffered } from '../providers.js';

const MINUTE = 60_000;
const START = Date.parse('2026-11-21T15:00:00.000Z');
const at = ms => new Date(ms).toISOString();

// Runs fn with the console captured, and gives back what fn returned and the lines it printed.
async function quietly(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...parts) => lines.push(parts.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

// ─── checkChains ──────────────────────────────────────────────────────────────

// Three stand-in providers' models, and two that a chain cannot hold: one with no price, one its provider retires.
const REGISTRY = {
  'alpha-1': { provider: 'alpha', price: [1, 4] },
  'alpha-2': { provider: 'alpha', price: [0.5, 2] },
  'beta-1': { provider: 'beta', price: [1, 5] },
  'gamma-1': { provider: 'gamma', price: [0.2, 1] },
  'alpha-unpriced': { provider: 'alpha' },
  'alpha-retiring': { provider: 'alpha', price: [1, 4], retiresOn: '2027-01-10' },
  'alpha-embed': { provider: 'alpha', price: [0.1, 0], embedding: true },
};
const standInEntry = name => (Object.hasOwn(REGISTRY, name) ? REGISTRY[name] : null);
const TODAY = Date.parse('2026-11-21T12:00:00.000Z');

// A measurement on record that meets the whole bar, unless told otherwise.
const measurement = (model, role, over = {}) => ({ model, role, measuredOn: '2026-11-20', runLabel: `${role}-${model}`, qualityOk: true, barOk: true, ...over });

// Everything checkChains is handed: every stand-in measured in both places and meeting the bar, every provider with
// its key set, and every model in its provider's list.
function facts(over = {}) {
  return {
    measurements: Object.keys(REGISTRY).flatMap(model => [measurement(model, 'answer'), measurement(model, 'small')]),
    keysPresent: ['alpha', 'beta', 'gamma'],
    liveModels: { alpha: ['alpha-1', 'alpha-2', 'alpha-unpriced', 'alpha-retiring', 'alpha-embed'], beta: ['beta-1'], gamma: ['gamma-1'] },
    override: false,
    now: TODAY,
    entryFor: standInEntry,
    ...over,
  };
}
const THREE = { answer: ['alpha-1', 'beta-1', 'gamma-1'], small: ['gamma-1', 'alpha-2', 'beta-1'] };

test('chains of three providers, each model measured and meeting what its place needs, may be saved, with nothing to say', () => {
  assert.deepEqual(checkChains(THREE, facts()), { ok: true, errors: [], warnings: [] });
});

test('a chain that names a model the registry does not have cannot be saved', () => {
  assert.deepEqual(checkChains({ ...THREE, answer: [...THREE.answer, 'delta-1'] }, facts()), {
    ok: false,
    errors: ['The reply chain names delta-1, which is not in the registry of models (model-registry.js).'],
    warnings: [],
  });
});

test('a chain that names a model with no price on record cannot be saved', () => {
  assert.deepEqual(checkChains({ ...THREE, answer: ['alpha-unpriced', 'beta-1', 'gamma-1'] }, facts()), {
    ok: false,
    errors: ['The reply chain names alpha-unpriced, which has no price on record, so the spending caps could not count what it costs.'],
    warnings: [],
  });
});

test('a chain that names a model its provider shuts down within 60 days, or has shut down, cannot be saved', () => {
  const chains = { ...THREE, small: ['gamma-1', 'alpha-retiring', 'beta-1'] };
  // alpha-retiring is shut down on 10 January 2027: 50 days on from midday on 21 November 2026, and 61 days on
  // from midday on 10 November.
  assert.deepEqual(checkChains(chains, facts()), {
    ok: false,
    errors: ['The small-job chain names alpha-retiring, which alpha shuts down on 2027-01-10, in 50 days: a model in a chain must have more than 60 days left.'],
    warnings: [],
  });
  assert.deepEqual(checkChains(chains, facts({ now: Date.parse('2026-11-10T12:00:00.000Z') })), { ok: true, errors: [], warnings: [] });
  assert.deepEqual(checkChains(chains, facts({ now: Date.parse('2027-01-10T00:00:00.000Z') })).errors,
    ['The small-job chain names alpha-retiring, which alpha shut down on 2027-01-10.']);
});

test('checkChains refuses gpt-4o, whose registry entry has OpenAI shutting it down on 14 January 2027, within 60 days of 21 November 2026; it and the three others retiring that day stay in the registry, priced', () => {
  // Plan 1's recorded runs are priced from these entries, so they are kept, with the day each is shut down.
  for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini']) {
    assert.equal(entryFor(model)?.retiresOn, '2027-01-14', model);
    assert.ok(Array.isArray(entryFor(model).price), `${model} has no price`);
  }
  const result = checkChains({ answer: ['gpt-4o'], small: ['gpt-6-luna'] }, {
    measurements: [measurement('gpt-4o', 'answer'), measurement('gpt-6-luna', 'small')],
    keysPresent: ['openai'],
    liveModels: { openai: ['gpt-4o', 'gpt-6-luna'] },
    now: TODAY,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['The reply chain names gpt-4o, which openai shuts down on 2027-01-14, in 54 days: a model in a chain must have more than 60 days left.']);
});

test('a chain that names a model whose provider has no key cannot be saved, and for the providers the app knows the setting that holds the key is named', () => {
  assert.deepEqual(checkChains(THREE, facts({ keysPresent: ['beta', 'gamma'] })), {
    ok: false,
    errors: ['The reply chain names alpha-1, but alpha has no key.', 'The small-job chain names alpha-2, but alpha has no key.'],
    warnings: [],
  });
  assert.deepEqual(KEY_NAMES, { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GEMINI_API_KEY' });
  const openai = checkChains({ answer: ['gpt-6-luna'], small: ['gpt-6-luna'] }, {
    measurements: [measurement('gpt-6-luna', 'answer'), measurement('gpt-6-luna', 'small')], keysPresent: [], liveModels: {}, now: TODAY,
  });
  assert.deepEqual(openai.errors, [
    'The reply chain names gpt-6-luna, but openai has no key (OPENAI_API_KEY is not set).',
    'The small-job chain names gpt-6-luna, but openai has no key (OPENAI_API_KEY is not set).',
  ]);
});

test("a chain that names a model its provider does not list today cannot be saved, nor one whose provider's list could not be read", () => {
  const lists = facts().liveModels;
  assert.deepEqual(checkChains(THREE, facts({ liveModels: { ...lists, beta: ['beta-2'] } })), {
    ok: false,
    errors: ['The reply chain names beta-1, which is not in the list of models beta offers today.', 'The small-job chain names beta-1, which is not in the list of models beta offers today.'],
    warnings: [],
  });
  assert.deepEqual(checkChains(THREE, facts({ liveModels: { ...lists, gamma: null } })).errors, [
    'The reply chain names gamma-1, but the list of models gamma offers could not be read to check it.',
    'The small-job chain names gamma-1, but the list of models gamma offers could not be read to check it.',
  ]);
});

test('in a chain of two providers or more, two models of one provider side by side cannot be saved', () => {
  assert.deepEqual(checkChains({ ...THREE, answer: ['alpha-1', 'alpha-2', 'beta-1', 'gamma-1'] }, facts()), {
    ok: false,
    errors: ["The reply chain puts alpha-1 and alpha-2, both alpha's, side by side: in a chain of more than one provider, the model after each must be another provider's, since an outage takes all of a provider's models at once."],
    warnings: [],
  });
  // Apart, they may be saved.
  assert.deepEqual(checkChains({ ...THREE, answer: ['alpha-1', 'beta-1', 'alpha-2', 'gamma-1'] }, facts()), { ok: true, errors: [], warnings: [] });
});

test('a chain of one provider may hold its models side by side, and is saved with a warning that it has no fallback if that provider is down', () => {
  assert.deepEqual(checkChains({ ...THREE, answer: ['alpha-1', 'alpha-2'] }, facts()), {
    ok: true, errors: [], warnings: ['The reply chain has one provider; it has no fallback if that provider is down.'],
  });
});

test('a chain of two providers is saved with a warning that it has fewer than three', () => {
  assert.deepEqual(checkChains({ ...THREE, small: ['gamma-1', 'beta-1'] }, facts()), {
    ok: true, errors: [], warnings: ['The small-job chain has two providers, not three: if both are down at once, it has no fallback.'],
  });
});

test('a chain that names a model with no measurement on record for that chain cannot be saved, though it is measured for the other', () => {
  const measurements = facts().measurements.filter(row => !(row.model === 'beta-1' && row.role === 'answer'));
  assert.deepEqual(checkChains(THREE, facts({ measurements })), {
    ok: false, errors: ['The reply chain names beta-1, which has no measurement on record as a reply model.'], warnings: [],
  });
});

test('a main model whose measurement misses the whole bar cannot be saved, though it may stand as a fallback', () => {
  const measurements = facts().measurements.map(row => (row.model === 'alpha-1' && row.role === 'answer' ? { ...row, barOk: false } : row));
  assert.deepEqual(checkChains(THREE, facts({ measurements })), {
    ok: false,
    errors: ['The reply chain has alpha-1 as its main model, but its measurement on record as a reply model does not meet the whole bar, which a main model must.'],
    warnings: [],
  });
  // A fallback needs only the quality part of the bar, which it meets.
  assert.deepEqual(checkChains({ ...THREE, answer: ['beta-1', 'alpha-1', 'gamma-1'] }, facts({ measurements })), { ok: true, errors: [], warnings: [] });
});

test('a fallback whose measurement misses the quality part of the bar cannot be saved', () => {
  const measurements = facts().measurements.map(row => (row.model === 'beta-1' && row.role === 'small' ? { ...row, qualityOk: false, barOk: false } : row));
  assert.deepEqual(checkChains(THREE, facts({ measurements })), {
    ok: false,
    errors: ['The small-job chain has beta-1 as a fallback, but its measurement on record as a small-job model does not meet the quality part of the bar, which a fallback must.'],
    warnings: [],
  });
});

test('the latest measurement on record for a model in its place is the one that counts', () => {
  const later = measurement('alpha-1', 'answer', { measuredOn: '2026-11-21', barOk: false });
  const earlier = measurement('alpha-1', 'answer', { measuredOn: '2026-11-01', barOk: false });
  assert.equal(checkChains(THREE, facts({ measurements: [...facts().measurements, later] })).ok, false);
  assert.equal(checkChains(THREE, facts({ measurements: [earlier, ...facts().measurements] })).ok, true);
});

test('under the override, a model with no measurement on record, or one that misses what its place needs, may be saved and the warnings say so; it lets nothing else through', () => {
  const measurements = facts().measurements
    .filter(row => !(row.model === 'beta-1' && row.role === 'answer'))
    .map(row => (row.model === 'gamma-1' && row.role === 'small' ? { ...row, barOk: false } : row))
    .map(row => (row.model === 'alpha-2' && row.role === 'small' ? { ...row, qualityOk: false } : row));
  assert.equal(checkChains(THREE, facts({ measurements })).errors.length, 3);
  assert.deepEqual(checkChains(THREE, facts({ measurements, override: true })), {
    ok: true,
    errors: [],
    warnings: [
      'Under the override, the reply chain names beta-1, which has no measurement on record as a reply model; the daily summary will say so until it has one.',
      'Under the override, the small-job chain has gamma-1 as its main model, though its measurement on record as a small-job model does not meet the whole bar.',
      'Under the override, the small-job chain has alpha-2 as a fallback, though its measurement on record as a small-job model does not meet the quality part of the bar.',
    ],
  });
  // The override is for measurements only.
  assert.deepEqual(checkChains({ ...THREE, answer: ['delta-1', 'beta-1', 'gamma-1'] }, facts({ override: true })).errors,
    ['The reply chain names delta-1, which is not in the registry of models (model-registry.js).']);
  assert.equal(checkChains(THREE, facts({ override: true, keysPresent: [] })).ok, false);
  assert.equal(checkChains({ ...THREE, answer: ['alpha-1', 'alpha-2', 'beta-1'] }, facts({ override: true })).ok, false);
});

test('a chain that is not a list of one or more model names, or that names one model twice, cannot be saved', () => {
  const neither = ['The reply chain must be a list of one or more model names.', 'The small-job chain must be a list of one or more model names.'];
  assert.deepEqual(checkChains({ answer: [], small: 'gamma-1' }, facts()), { ok: false, errors: neither, warnings: [] });
  assert.deepEqual(checkChains(null, facts()).errors, neither);
  assert.deepEqual(checkChains({ answer: ['alpha-1', ''], small: THREE.small }, facts()).errors, [neither[0]]);
  assert.deepEqual(checkChains({ ...THREE, answer: ['alpha-1', 'beta-1', 'alpha-1'] }, facts()).errors, ['The reply chain names alpha-1 twice.']);
});

// ─── The database, and an instance of the settings over it ───────────────────

// The two tables, and a client that runs on them each statement model-settings.js sends, with its values as Neon
// sends them. A statement it does not know is refused, and gone(table) makes every statement on a table fail, as for
// a table never made. Each statement is kept in `sent`. holdReads() keeps the answer to every read of the saved chains
// waiting until the function it returns is called; the read finds what the table held when it was sent, as a
// statement does in Postgres.
function settingsDatabase() {
  const settings = new Map();
  const measured = [];
  const sent = [];
  const missing = new Set();
  let held = null;
  const statements = [
    [/^SELECT value FROM app_settings WHERE key = \?$/, 'app_settings', async ([key]) => {
      const found = settings.has(key) ? [{ value: JSON.parse(settings.get(key)) }] : [];
      if (held) await held;
      return found;
    }],
    [/^INSERT INTO app_settings \(key, value, updated_at\) VALUES \(\?, \?::jsonb, now\(\)\) ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value, updated_at = now\(\)$/, 'app_settings',
      ([key, value]) => { settings.set(key, JSON.stringify(JSON.parse(value))); return []; }],
    [/^SELECT model, role, measured_on::text AS measured_on, run_label, quality_ok, bar_ok, stats->'barFailed' AS bar_failed FROM model_measurements WHERE app = \? ORDER BY measured_on, id$/, 'model_measurements',
      ([app]) => measured.filter(row => row.app === app).sort((a, b) => a.measured_on.localeCompare(b.measured_on))
        .map(({ model, role, measured_on, run_label, quality_ok, bar_ok, stats }) => ({ model, role, measured_on, run_label, quality_ok, bar_ok, bar_failed: stats?.barFailed ?? null }))],
    // A row of this run's label is stored, or replaced when it differs; one identical to the stored row is stored as nothing.
    [/^INSERT INTO model_measurements \(app, model, role, measured_on, run_label, quality_ok, bar_ok, stats\) VALUES \(\?, \?, \?, \?::date, \?, \?, \?, \?::jsonb\) ON CONFLICT \(app, model, role, run_label\) DO UPDATE SET measured_on = EXCLUDED\.measured_on, quality_ok = EXCLUDED\.quality_ok, bar_ok = EXCLUDED\.bar_ok, stats = EXCLUDED\.stats WHERE \(model_measurements\.measured_on, model_measurements\.quality_ok, model_measurements\.bar_ok, model_measurements\.stats\) IS DISTINCT FROM \(EXCLUDED\.measured_on, EXCLUDED\.quality_ok, EXCLUDED\.bar_ok, EXCLUDED\.stats\) RETURNING id$/, 'model_measurements',
      ([app, model, role, measured_on, run_label, quality_ok, bar_ok, stats]) => {
        const row = { app, model, role, measured_on, run_label, quality_ok: quality_ok === 'true' || quality_ok === true, bar_ok: bar_ok === 'true' || bar_ok === true, stats: JSON.parse(stats) };
        const at = measured.findIndex(held => held.app === app && held.model === model && held.role === role && held.run_label === run_label);
        if (at === -1) { measured.push(row); return [{ id: measured.length }]; }
        const { measured_on: on, quality_ok: quality, bar_ok: bar, stats: held } = measured[at];
        if (isDeepStrictEqual([on, quality, bar, held], [row.measured_on, row.quality_ok, row.bar_ok, row.stats])) return [];
        measured[at] = row;
        return [{ id: at + 1 }];
      }],
  ];
  const sql = async (strings, ...params) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    sent.push({ query, params });
    await null;
    const known = statements.find(([pattern]) => pattern.test(query));
    if (!known) throw new Error(`The fake database does not know this statement: ${query}`);
    if (missing.has(known[1])) throw new Error(`relation "${known[1]}" does not exist`);
    return known[2](params);
  };
  return {
    sql,
    sent,
    settings,
    // A row saved by another instance, or by hand.
    save: (key, value) => settings.set(key, JSON.stringify(value)),
    // What model_measurements holds, in the order it was stored.
    measurements: () => measured,
    measure: row => measured.push({ app: 'stand-in', measured_on: '2026-11-20', run_label: `${row.role}-${row.model}`, quality_ok: true, bar_ok: true, ...row }),
    gone: table => missing.add(table),
    holdReads: () => {
      let release;
      held = new Promise(resolve => { release = resolve; });
      return () => { held = null; release(); };
    },
  };
}

// Each model of the chains measured in each place it holds, meeting the whole bar.
function measureAll(db, chains) {
  for (const model of chains.answer) db.measure({ model, role: 'answer' });
  for (const model of chains.small) db.measure({ model, role: 'small' });
}

// What OpenAI lists today, as far as these tests go.
const OFFERED = { openai: ['gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.4-mini', 'gpt-5.4-nano'] };

// Instances of the settings over one database, with the test's time, the environment they are given, and stand-ins
// for what each provider lists today (each call kept in `listed`) and for the owner's telling (each note in `told`).
function settingsWorld({ env = { OPENAI_API_KEY: 'set' }, offered = OFFERED } = {}) {
  const db = settingsDatabase();
  let time = START;
  const clock = { now: () => time, pass: ms => { time += ms; } };
  const listed = [];
  const told = [];
  const instance = () => modelSettings({
    sqlClient: db.sql,
    app: 'stand-in',
    now: clock.now,
    env,
    tell: note => { told.push(note); },
    modelsOffered: async providers => {
      listed.push(providers);
      return Object.fromEntries(providers.map(provider => [provider, offered[provider] ?? null]));
    },
  });
  return { db, clock, listed, told, instance };
}

const BUILT_IN = { answer: [...DEFAULTS.answer], small: [...DEFAULTS.small], source: 'defaults', override: null };
const ONE_PROVIDER = ['The reply chain has one provider; it has no fallback if that provider is down.', 'The small-job chain has one provider; it has no fallback if that provider is down.'];

// ─── saveChains ───────────────────────────────────────────────────────────────

test("saveChains checks the chains against this app's measurements on record, the providers whose key is set, asked by the key's name alone, and each such provider's list, and saves them only when nothing is wrong", async () => {
  const { db, instance, listed } = settingsWorld({ env: { OPENAI_API_KEY: 'sk-proj-abcDEF1234567890wxyz', ANTHROPIC_API_KEY: '' } });
  const proposed = { answer: ['gpt-6.1-terra', 'gpt-6-luna'], small: ['gpt-6-luna', 'gpt-5.4-mini'] };
  measureAll(db, proposed);
  // gpt-6.2-sol is on record for another app only, which vouches for nothing here.
  db.measure({ app: 'another-app', model: 'gpt-6.2-sol', role: 'answer' });
  const settings = instance();
  const { result: [refused, saved], lines } = await quietly(async () => [
    await settings.saveChains({ ...proposed, answer: ['gpt-6.2-sol'] }, { by: 'owner' }),
    await settings.saveChains(proposed, { by: 'owner' }),
  ]);
  assert.deepEqual(refused, { ok: false, errors: ['The reply chain names gpt-6.2-sol, which has no measurement on record as a reply model.'], warnings: ONE_PROVIDER });
  assert.deepEqual(saved, { ok: true, errors: [], warnings: ONE_PROVIDER });
  assert.deepEqual(JSON.parse(db.settings.get('model_chains')), proposed, 'the row holds the chains and no override');
  // Each save asked for the lists of the providers with a key, and of no other; it read this app's measurements.
  assert.deepEqual(listed, [['openai'], ['openai']]);
  const reads = db.sent.filter(call => /FROM model_measurements/.test(call.query));
  assert.equal(reads.length, 2);
  assert.ok(reads.every(call => call.params[0] === 'stand-in'));
  assert.deepEqual(lines, []);
});

test('saveChains refuses the models of a provider with no key set, and asks no list of it', async () => {
  const { db, instance, listed } = settingsWorld({ env: {} });
  const proposed = { answer: ['gpt-6.1-terra'], small: ['gpt-6-luna'] };
  measureAll(db, proposed);
  assert.deepEqual(await instance().saveChains(proposed, { by: 'owner' }), {
    ok: false,
    errors: ['The reply chain names gpt-6.1-terra, but openai has no key (OPENAI_API_KEY is not set).', 'The small-job chain names gpt-6-luna, but openai has no key (OPENAI_API_KEY is not set).'],
    warnings: ONE_PROVIDER,
  });
  assert.deepEqual(listed, []);
  assert.equal(db.settings.size, 0);
});

test('the override lets an unmeasured model be saved, and the row records who used it, when, and which models it let in for which place', async () => {
  const { db, instance, clock } = settingsWorld();
  const proposed = { answer: ['gpt-6.2-sol', 'gpt-6.1-terra'], small: ['gpt-6-luna'] };
  db.measure({ model: 'gpt-6.1-terra', role: 'answer' });
  // As the owner chose it on 21 November 2026: measured, and missing rules of the bar.
  db.measure({ model: 'gpt-6-luna', role: 'small', bar_ok: false });
  const settings = instance();
  assert.deepEqual((await settings.saveChains(proposed, { by: 'owner' })).errors, [
    'The reply chain names gpt-6.2-sol, which has no measurement on record as a reply model.',
    'The small-job chain has gpt-6-luna as its main model, but its measurement on record as a small-job model does not meet the whole bar, which a main model must.',
  ]);
  assert.equal(db.settings.size, 0);

  clock.pass(MINUTE);
  const saved = await settings.saveChains(proposed, { by: 'owner', override: true });
  assert.equal(saved.ok, true);
  assert.deepEqual(JSON.parse(db.settings.get('model_chains')), {
    ...proposed,
    override: { overriddenBy: 'owner', overriddenOn: at(START + MINUTE), models: [{ model: 'gpt-6.2-sol', role: 'answer' }, { model: 'gpt-6-luna', role: 'small' }] },
  });

  // A save that needs no override records none, even with it ticked.
  db.measure({ model: 'gpt-6.2-sol', role: 'answer' });
  db.measure({ model: 'gpt-6-luna', role: 'small', measured_on: '2026-11-22' });
  assert.equal((await settings.saveChains(proposed, { by: 'owner', override: true })).ok, true);
  assert.deepEqual(JSON.parse(db.settings.get('model_chains')), proposed);
  // Who saves is always said.
  await assert.rejects(settings.saveChains(proposed, {}), TypeError);
  await assert.rejects(settings.saveChains(proposed, { by: ' ', override: true }), TypeError);
});

// ─── chains() ─────────────────────────────────────────────────────────────────

test('with no chains saved, chains() gives the built-in chains with source "defaults", reads the row at most once a minute, and says so once', async () => {
  const { db, instance, clock } = settingsWorld();
  const settings = instance();
  const { result, lines } = await quietly(async () => {
    // Callers at the same moment share one read.
    const first = await Promise.all([settings.chains(), settings.chains()]);
    const again = await settings.chains();
    clock.pass(MINUTE);
    return [...first, again, await settings.chains()];
  });
  for (const given of result) assert.deepEqual(given, BUILT_IN);
  assert.deepEqual(db.sent.map(call => call.query), ['SELECT value FROM app_settings WHERE key = ?', 'SELECT value FROM app_settings WHERE key = ?']);
  assert.deepEqual(db.sent[0].params, ['model_chains']);
  assert.deepEqual(lines, ['[models] No model chains are saved in the settings, so the built-in chains are used.']);
});

test('when the saved chains cannot be read, chains() gives the built-in chains, logs it once, and reads again a minute later; a row that is not two lists of names is the same', async () => {
  const { db, instance, clock } = settingsWorld();
  db.gone('app_settings');
  const settings = instance();
  const { result, lines } = await quietly(async () => {
    const first = await settings.chains();
    clock.pass(MINUTE);
    return [first, await settings.chains()];
  });
  assert.deepEqual(result, [BUILT_IN, BUILT_IN]);
  assert.equal(db.sent.length, 2);
  assert.deepEqual(lines, ['[models] The saved model chains could not be read, so the built-in chains are used: relation "app_settings" does not exist']);

  const malformed = settingsWorld();
  malformed.db.save('model_chains', { answer: 'gpt-6-luna', small: [] });
  const { result: given, lines: said } = await quietly(() => malformed.instance().chains());
  assert.deepEqual(given, BUILT_IN);
  assert.deepEqual(said, ['[models] The saved model chains are not two lists of model names, so the built-in chains are used.']);
});

test('when the saved chains name a model the registry does not have, chains() gives the built-in chains and tells the owner at each read, without the job waiting for the telling', async () => {
  const { db, clock } = settingsWorld();
  db.save('model_chains', { answer: ['gpt-6-luna', 'gpt-0-gone'], small: ['gpt-6-luna'] });
  const told = [];
  // An email that never finishes sending.
  const settings = modelSettings({ sqlClient: db.sql, app: 'stand-in', now: clock.now, tell: note => { told.push(note); return new Promise(() => {}); } });
  const { result, lines } = await quietly(async () => {
    const first = await settings.chains();
    const again = await settings.chains();
    clock.pass(MINUTE);
    return [first, again, await settings.chains()];
  });
  assert.deepEqual(result, [BUILT_IN, BUILT_IN, BUILT_IN]);
  // Told at each read of the row, so at most once a minute: the app's telling emails the owner once a day.
  assert.deepEqual(told, [{ kind: 'unknown_models', models: ['gpt-0-gone'] }, { kind: 'unknown_models', models: ['gpt-0-gone'] }]);
  assert.deepEqual(lines, ['[models] The saved model chains name gpt-0-gone, which the registry of models does not have, so the built-in chains are used.']);

  // A telling that fails is logged, and the job goes on with the built-in chains.
  const failing = modelSettings({ sqlClient: db.sql, app: 'stand-in', tell: () => { throw new Error('the mail server is down'); } });
  const { result: anyway, lines: logged } = await quietly(async () => {
    const given = await failing.chains();
    await new Promise(resolve => setImmediate(resolve));
    return given;
  });
  assert.deepEqual(anyway, BUILT_IN);
  assert.ok(logged.includes('[models] Telling the owner that the saved model chains name a model the registry does not have failed: the mail server is down'), logged.join('\n'));
});

test('saved chains are what chains() gives, with source "settings": at once on the instance that saved them, on another within a minute, and each reads the row again after its minute', async () => {
  const { db, instance, clock } = settingsWorld();
  const proposed = { answer: ['gpt-6-luna', 'gpt-5.4-mini'], small: ['gpt-5.4-mini'] };
  measureAll(db, proposed);
  const saver = instance();
  const other = instance();
  await quietly(async () => assert.deepEqual(await other.chains(), BUILT_IN));
  assert.equal((await saver.saveChains(proposed, { by: 'owner' })).ok, true);
  const reads = () => db.sent.filter(call => /FROM app_settings WHERE/.test(call.query)).length;
  const before = reads();
  assert.deepEqual(await saver.chains(), { ...proposed, source: 'settings', override: null });
  assert.equal(reads(), before, 'the instance that saved read its own row back');

  clock.pass(MINUTE - 1);
  assert.deepEqual(await other.chains(), BUILT_IN, 'another instance read the row again inside its minute');
  clock.pass(1);
  assert.deepEqual(await other.chains(), { ...proposed, source: 'settings', override: null });
  // What a caller is given is its own: changing it changes nothing for the next caller.
  const given = await other.chains();
  given.answer.push('gpt-6.2-sol');
  given.small.length = 0;
  assert.deepEqual(await other.chains(), { ...proposed, source: 'settings', override: null });

  // A row changed elsewhere is read after the minute.
  db.save('model_chains', { answer: ['gpt-6.1-terra'], small: ['gpt-6-luna'] });
  clock.pass(MINUTE);
  assert.deepEqual(await saver.chains(), { answer: ['gpt-6.1-terra'], small: ['gpt-6-luna'], source: 'settings', override: null });
});

test('a save made while the row is being read is what the instance gives afterwards, not what the read found', async () => {
  const { db, instance } = settingsWorld();
  const proposed = { answer: ['gpt-6.1-terra'], small: ['gpt-6-luna'] };
  measureAll(db, proposed);
  const settings = instance();
  const release = db.holdReads();
  const { result: [read] } = await quietly(async () => {
    const reading = settings.chains();
    assert.equal((await settings.saveChains(proposed, { by: 'owner' })).ok, true);
    release();
    return [await reading];
  });
  // The read began before the save: its caller may be given either, but the instance keeps the save.
  assert.ok(['defaults', 'settings'].includes(read.source));
  assert.deepEqual(await settings.chains(), { ...proposed, source: 'settings', override: null });
});

test('with no database, chains() gives the built-in chains and reads nothing, a save is refused, and no measurement or override is on record', async () => {
  const settings = modelSettings();
  const { result, lines } = await quietly(async () => [
    await settings.chains(),
    await settings.saveChains({ answer: ['gpt-6-luna'], small: ['gpt-6-luna'] }, { by: 'owner' }),
    await settings.measurements(),
    await settings.unmeasuredOverride(),
  ]);
  assert.deepEqual(result, [BUILT_IN, { ok: false, errors: ['The chains cannot be saved: the app has no database for its settings.'], warnings: [] }, [], null]);
  assert.deepEqual(lines, []);
});

// ─── A measurement run ────────────────────────────────────────────────────────

test("useChainsForMeasurement throws under any database address but the measurement's own, and under it makes chains() give the chains it was handed from then on, reading no settings", async () => {
  for (const address of [undefined, 'postgres://user:pass@localhost:5432/testdb', `${MEASURE_DATABASE_URL}-not`]) {
    const settings = modelSettings({ env: { DATABASE_URL: address } });
    assert.throws(() => settings.useChainsForMeasurement({ answer: ['gpt-6.2-sol'], small: ['gpt-5.4-nano'] }), /only in a measurement run/, String(address));
    assert.deepEqual(await settings.chains(), BUILT_IN);
  }
  const { db } = settingsWorld();
  db.save('model_chains', { answer: ['gpt-6.1-terra'], small: ['gpt-6-luna'] });
  const settings = modelSettings({ sqlClient: db.sql, app: 'stand-in', env: { DATABASE_URL: MEASURE_DATABASE_URL } });
  settings.useChainsForMeasurement({ answer: ['gpt-6.2-sol'], small: ['gpt-5.4-nano'] });
  assert.deepEqual(await settings.chains(), { answer: ['gpt-6.2-sol'], small: ['gpt-5.4-nano'], source: 'measurement', override: null });
  assert.equal(await settings.unmeasuredOverride(), null);
  assert.deepEqual(db.sent, []);
  assert.throws(() => settings.useChainsForMeasurement({ answer: [], small: ['gpt-5.4-nano'] }), TypeError);
});

// ─── The measurements on record, and the override ────────────────────────────

test('the measurements on record are read for this app alone, and a table that cannot be read gives none, logged once', async () => {
  const { db, instance } = settingsWorld();
  db.measure({ model: 'gpt-6-luna', role: 'small', measured_on: '2026-11-21', run_label: 'small-gpt-6-luna', bar_ok: false, stats: { barFailed: ['type', 'tier'] } });
  db.measure({ app: 'another-app', model: 'gpt-6.2-sol', role: 'answer' });
  db.measure({ model: 'gpt-6.1-terra', role: 'answer', measured_on: '2026-11-20', run_label: 'reply-gpt-6.1-terra' });
  assert.deepEqual(await instance().measurements(), [
    { model: 'gpt-6.1-terra', role: 'answer', measuredOn: '2026-11-20', runLabel: 'reply-gpt-6.1-terra', qualityOk: true, barOk: true, failed: [] },
    { model: 'gpt-6-luna', role: 'small', measuredOn: '2026-11-21', runLabel: 'small-gpt-6-luna', qualityOk: true, barOk: false, failed: ['type', 'tier'] },
  ]);
  db.gone('model_measurements');
  const settings = instance();
  const { result, lines } = await quietly(async () => [await settings.measurements(), await settings.measurements()]);
  assert.deepEqual(result, [[], []]);
  assert.deepEqual(lines, ['[models] The measurements on record could not be read, so none is counted: relation "model_measurements" does not exist']);
});

test('the override is named for as long as a model it let in has no measurement on record for the place it holds, and not once each has one', async () => {
  const { db, instance } = settingsWorld();
  const proposed = { answer: ['gpt-6.2-sol', 'gpt-6.1-terra'], small: ['gpt-6-luna'] };
  db.measure({ model: 'gpt-6.1-terra', role: 'answer' });
  db.measure({ model: 'gpt-6-luna', role: 'small', bar_ok: false });
  const settings = instance();
  assert.equal((await settings.saveChains(proposed, { by: 'owner', override: true })).ok, true);
  // gpt-6-luna was let in too, but it has a measurement on record: only gpt-6.2-sol is named.
  assert.deepEqual(await settings.unmeasuredOverride(), { overriddenBy: 'owner', overriddenOn: at(START), models: [{ model: 'gpt-6.2-sol', role: 'answer' }] });
  // A measurement for the other place does not count.
  db.measure({ model: 'gpt-6.2-sol', role: 'small' });
  assert.deepEqual((await settings.unmeasuredOverride())?.models, [{ model: 'gpt-6.2-sol', role: 'answer' }]);
  db.measure({ model: 'gpt-6.2-sol', role: 'answer' });
  assert.equal(await settings.unmeasuredOverride(), null);
  // Chains saved with no override name none, and nor do the built-in chains.
  assert.equal((await settings.saveChains({ answer: ['gpt-6.1-terra'], small: ['gpt-6-luna'] }, { by: 'owner' })).ok, false);
  const fresh = settingsWorld();
  await quietly(async () => assert.equal(await fresh.instance().unmeasuredOverride(), null));
});

// ─── Added with the admin page ────────────────────────────────────────────────

test('an embedding model cannot be saved in a chat chain, and the override does not lift that', () => {
  const proposed = { ...THREE, answer: ['alpha-1', 'alpha-embed'] };
  const refusal = 'The reply chain names alpha-embed, which is an embedding model, not one that writes answers.';
  assert.ok(checkChains(proposed, facts()).errors.includes(refusal));
  const overridden = checkChains(proposed, facts({ override: true }));
  assert.equal(overridden.ok, false);
  assert.ok(overridden.errors.includes(refusal));
  // The real registry's embedding models are refused the same way.
  const real = checkChains({ answer: ['gpt-6.1-terra', 'text-embedding-3-small'], small: ['gpt-6-luna'] }, { keysPresent: ['openai'], liveModels: { openai: ['gpt-6.1-terra', 'gpt-6-luna', 'text-embedding-3-small'] }, override: true, now: TODAY });
  assert.ok(real.errors.includes('The reply chain names text-embedding-3-small, which is an embedding model, not one that writes answers.'));
});

test('a save whose write fails says so, without any key the database quoted, and stores nothing', async () => {
  const { db, instance } = settingsWorld();
  const proposed = { answer: ['gpt-6.1-terra'], small: ['gpt-6-luna'] };
  measureAll(db, proposed);
  const flaky = (strings, ...params) => (/^\s*INSERT INTO app_settings/.test(strings.join('?'))
    ? Promise.reject(new Error('the database refused sk-proj-abcDEF1234567890wxyz'))
    : db.sql(strings, ...params));
  const settings = modelSettings({ sqlClient: flaky, app: 'stand-in', env: { OPENAI_API_KEY: 'set' }, modelsOffered: async () => OFFERED });
  const saved = await settings.saveChains(proposed, { by: 'owner' });
  assert.equal(saved.ok, false);
  assert.deepEqual(saved.errors, ['The chains could not be saved: the database refused [key withheld]']);
  assert.equal(db.settings.size, 0);
  const { result: read } = await quietly(() => instance().chains());
  assert.equal(read.source, 'defaults');
});

test('a provider that has a key but no adapter gives the error that its list of models could not be read', async () => {
  const db = settingsDatabase();
  const proposed = { answer: ['gpt-6.1-terra'], small: ['gpt-6-luna'] };
  measureAll(db, proposed);
  // The real reader, given no adapters: every provider is a null list.
  const settings = modelSettings({ sqlClient: db.sql, app: 'stand-in', env: { OPENAI_API_KEY: 'set' }, modelsOffered: providers => modelsOffered(providers, { adapters: {} }) });
  const saved = await settings.saveChains(proposed, { by: 'owner' });
  assert.equal(saved.ok, false);
  assert.deepEqual(saved.errors, [
    'The reply chain names gpt-6.1-terra, but the list of models openai offers could not be read to check it.',
    'The small-job chain names gpt-6-luna, but the list of models openai offers could not be read to check it.',
  ]);
  assert.equal(db.settings.size, 0);
});

test('a database error that quotes a key is logged without it, when the chains or the measurements cannot be read', async () => {
  const quoting = () => Promise.reject(new Error('refused sk-proj-abcDEF1234567890wxyz'));
  const settings = modelSettings({ sqlClient: quoting, app: 'stand-in' });
  const { lines } = await quietly(async () => { await settings.chains(); await settings.measurements(); });
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => line.includes('[key withheld]') && !line.includes('sk-proj')), lines.join(' | '));
});

test('chains() also gives the override of the saved row, or null, and a measurement on record gives the rules it missed', async () => {
  const { db, instance } = settingsWorld();
  const proposed = { answer: ['gpt-6.2-sol', 'gpt-6.1-terra'], small: ['gpt-6-luna'] };
  db.measure({ model: 'gpt-6.1-terra', role: 'answer' });
  db.measure({ model: 'gpt-6-luna', role: 'small', bar_ok: false, stats: { barFailed: ['speed'] } });
  const settings = instance();
  assert.equal((await settings.saveChains(proposed, { by: 'owner', override: true })).ok, true);
  const given = await settings.chains();
  assert.deepEqual(given.override, { overriddenBy: 'owner', overriddenOn: at(START), models: [{ model: 'gpt-6.2-sol', role: 'answer' }, { model: 'gpt-6-luna', role: 'small' }] });
  given.override.models.length = 0;
  assert.equal((await settings.chains()).override.models.length, 2, 'what a caller is given is its own');
  assert.deepEqual((await settings.measurements()).map(({ model, failed }) => [model, failed]), [['gpt-6.1-terra', []], ['gpt-6-luna', ['speed']]]);
});

// ─── Measurements sent to the site ────────────────────────────────────────────

const GOOD_ROW = { model: 'gpt-6-luna', role: 'small', measuredOn: '2026-11-20', runLabel: 'small-gpt-6-luna', qualityOk: true, barOk: false, failed: ['type', 'speed'], stats: { jsonValidRate: 1, typeAgreement: 0.91 } };

test('measurement rows are checked as a whole before any is stored, and each problem names its row', () => {
  assert.deepEqual(checkMeasurementRows([GOOD_ROW, { ...GOOD_ROW, role: 'answer', failed: ['finalPass'], runLabel: 'reply-x' }]), []);
  assert.deepEqual(checkMeasurementRows([]), ['The upload holds no rows.']);
  assert.deepEqual(checkMeasurementRows('rows'), ['The upload holds no rows.']);
  const problems = checkMeasurementRows([
    { ...GOOD_ROW, model: '' },
    { ...GOOD_ROW, runLabel: 'x', role: 'both' },
    { ...GOOD_ROW, runLabel: 'y', measuredOn: '2026-02-30' },
    { ...GOOD_ROW, runLabel: 'z', measuredOn: 'yesterday' },
    { ...GOOD_ROW, runLabel: '../q' },
    { ...GOOD_ROW, runLabel: 'a', qualityOk: 'yes' },
    { ...GOOD_ROW, runLabel: 'b', barOk: 1 },
    { ...GOOD_ROW, runLabel: 'c', failed: ['finalPass'] },
    { ...GOOD_ROW, runLabel: 'd', failed: ['nonsense'] },
    { ...GOOD_ROW, runLabel: 'e', failed: 'speed' },
    { ...GOOD_ROW, runLabel: 'f', barOk: true },
    { ...GOOD_ROW, runLabel: 'g', stats: [] },
    { ...GOOD_ROW, runLabel: 'h', stats: null },
    GOOD_ROW,
    GOOD_ROW,
    null,
  ]);
  assert.deepEqual(problems, [
    'Row 1 (, small-gpt-6-luna): model must be a name.',
    'Row 2 (gpt-6-luna, x): role must be "answer" or "small".',
    'Row 3 (gpt-6-luna, y): measuredOn must be a date as YYYY-MM-DD.',
    'Row 4 (gpt-6-luna, z): measuredOn must be a date as YYYY-MM-DD.',
    'Row 5 (gpt-6-luna, ../q): runLabel must be a run label: letters, digits, dots and hyphens.',
    'Row 6 (gpt-6-luna, a): qualityOk must be true or false.',
    'Row 7 (gpt-6-luna, b): barOk must be true or false.',
    'Row 8 (gpt-6-luna, c): failed names finalPass, which is not a rule of the small-job bar.',
    'Row 9 (gpt-6-luna, d): failed names nonsense, which is not a rule of the small-job bar.',
    'Row 10 (gpt-6-luna, e): failed must be a list of rules.',
    'Row 11 (gpt-6-luna, f): barOk is true, but failed names rules.',
    'Row 12 (gpt-6-luna, g): stats must be an object.',
    'Row 13 (gpt-6-luna, h): stats must be an object.',
    'Row 15 (gpt-6-luna, small-gpt-6-luna) repeats row 14.',
    'Row 16 (?, ?): a row must be an object.',
  ]);
  // Too much to keep as one row's figures.
  assert.deepEqual(checkMeasurementRows([{ ...GOOD_ROW, stats: { big: 'x'.repeat(200_000) } }]), ['Row 1 (gpt-6-luna, small-gpt-6-luna): stats is too large.']);
});

test('recordMeasurements stores each row for this app with the rules it missed among its figures, stores an identical row again as nothing, and replaces a row of the same run that was corrected', async () => {
  const { db, instance } = settingsWorld();
  const settings = instance();
  const rows = [GOOD_ROW, { ...GOOD_ROW, model: 'gpt-6.1-terra', role: 'answer', runLabel: 'reply-gpt-6.1-terra', barOk: true, failed: [] }];
  assert.deepEqual(await settings.recordMeasurements(rows), { ok: true, errors: [], saved: 2 });
  assert.deepEqual(db.measurements().map(({ app, model, role, run_label, measured_on, bar_ok, quality_ok, stats }) => ({ app, model, role, run_label, measured_on, bar_ok, quality_ok, stats })), [
    { app: 'stand-in', model: 'gpt-6-luna', role: 'small', run_label: 'small-gpt-6-luna', measured_on: '2026-11-20', bar_ok: false, quality_ok: true, stats: { jsonValidRate: 1, typeAgreement: 0.91, barFailed: ['type', 'speed'] } },
    { app: 'stand-in', model: 'gpt-6.1-terra', role: 'answer', run_label: 'reply-gpt-6.1-terra', measured_on: '2026-11-20', bar_ok: true, quality_ok: true, stats: { jsonValidRate: 1, typeAgreement: 0.91, barFailed: [] } },
  ]);
  // The same upload again stores none.
  assert.deepEqual(await settings.recordMeasurements(rows), { ok: true, errors: [], saved: 0 });
  assert.equal(db.measurements().length, 2);
  // A corrected row of the same run replaces its row, and only it.
  const corrected = { ...GOOD_ROW, barOk: true, failed: [], stats: { jsonValidRate: 1, typeAgreement: 0.99 } };
  assert.deepEqual(await settings.recordMeasurements([corrected, rows[1]]), { ok: true, errors: [], saved: 1 });
  assert.equal(db.measurements().length, 2);
  assert.deepEqual(db.measurements()[0].stats, { jsonValidRate: 1, typeAgreement: 0.99, barFailed: [] });
  assert.equal(db.measurements()[0].bar_ok, true);
  // What is on record is what the settings read back, rules included.
  assert.deepEqual((await settings.measurements()).map(({ model, barOk, failed }) => [model, barOk, failed]), [['gpt-6-luna', true, []], ['gpt-6.1-terra', true, []]]);
  // The figures' own barFailed, if a caller sent one, never outranks the rules of the row.
  await settings.recordMeasurements([{ ...GOOD_ROW, runLabel: 'other', stats: { barFailed: ['json'] } }]);
  assert.deepEqual(db.measurements().at(-1).stats.barFailed, ['type', 'speed']);
});

test('recordMeasurements stores nothing when any row is malformed, says why when the database fails, and has no database to store in when there is none', async () => {
  const { db, instance } = settingsWorld();
  const settings = instance();
  const refused = await settings.recordMeasurements([GOOD_ROW, { ...GOOD_ROW, runLabel: 'bad', role: 'neither' }]);
  assert.deepEqual(refused, { ok: false, errors: ['Row 2 (gpt-6-luna, bad): role must be "answer" or "small".'], saved: 0 });
  assert.equal(db.measurements().length, 0);
  db.gone('model_measurements');
  const failed = await settings.recordMeasurements([GOOD_ROW]);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.errors, ['The measurements could not be saved: relation "model_measurements" does not exist']);
  assert.deepEqual((await modelSettings().recordMeasurements([GOOD_ROW])).errors, ['The measurements cannot be saved: the app has no database for its settings.']);
});
