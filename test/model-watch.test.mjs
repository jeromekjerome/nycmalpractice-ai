// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The monthly look at each provider's models, and the reminder before a model retires (model-watch.js). A table kept in
// memory stands in for provider_model_lists: it runs the statements the module sends and refuses any it does not know.
// The adapters, the table and the email are fakes. Nothing here reaches a network or a database.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { modelWatch } from '../model-watch.js';

const REGISTRY = {
  'gpt-6.1-terra': { provider: 'openai' },
  'gpt-4o': { provider: 'openai', retiresOn: '2027-01-14' },
  'claude-haiku-5-5': { provider: 'anthropic' },
  'gemini-3.5-flash-lite': { provider: 'google' },
};
const IN_USE = ['gpt-6.1-terra', 'claude-haiku-5-5', 'gemini-3.5-flash-lite'];
const LISTS = {
  openai: ['gpt-6.1-terra', 'gpt-6-luna', 'text-embedding-3-small'],
  anthropic: ['claude-haiku-5-5', 'claude-opus-5-5'],
  google: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'],
};

// The table, and a client that runs the statements model-watch.js sends. `sent` keeps each one. gone() makes every
// statement fail, as for a table never made.
function listTable(stored = []) {
  const rows = stored.map(([provider, month, models]) => ({ provider, month, models }));
  const sent = [];
  let missing = false;
  const statements = [
    [/^SELECT provider FROM provider_model_lists WHERE month = \?$/, ([month]) => rows.filter(row => row.month === month).map(row => ({ provider: row.provider }))],
    [/^SELECT models FROM provider_model_lists WHERE provider = \? AND month < \? ORDER BY month DESC LIMIT 1$/,
      ([provider, month]) => rows.filter(row => row.provider === provider && row.month < month).sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, 1).map(row => ({ models: row.models }))],
    [/^INSERT INTO provider_model_lists \(provider, month, models\) VALUES \(\?, \?, \?::jsonb\) ON CONFLICT \(provider, month\) DO NOTHING RETURNING provider$/,
      ([provider, month, models]) => {
        if (rows.some(row => row.provider === provider && row.month === month)) return [];
        rows.push({ provider, month, models: JSON.parse(models) });
        return [{ provider }];
      }],
  ];
  const client = async (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    sent.push(text);
    if (missing) throw new Error('relation "provider_model_lists" does not exist');
    const statement = statements.find(([pattern]) => pattern.test(text));
    if (!statement) throw new Error(`The fake table does not know the statement: ${text}`);
    return statement[1](values);
  };
  return { client, rows, sent, gone() { missing = true; } };
}

function fakeAdapter(name, models) {
  const adapter = { name, asked: 0, async listModels() { adapter.asked += 1; if (models instanceof Error) throw models; return models; } };
  return adapter;
}

function world({ stored = [], lists = LISTS, registry = REGISTRY, inUse = IN_USE, keyed = ['openai', 'anthropic', 'google'] } = {}) {
  const table = listTable(stored);
  const sent = [];
  const adapters = Object.fromEntries(keyed.map(name => [name, fakeAdapter(name, lists[name])]));
  const watch = today => modelWatch({ today, sqlClient: table.client, adapters, notify: async (subject, html) => { sent.push({ subject, html }); }, registry, inUse: async () => inUse, site: 'NYCInjury.ai' });
  return { table, sent, adapters, watch };
}

const NOV_21 = new Date('2026-11-21T14:00:00Z');
const LAST_MONTH = [['openai', '2026-10-01', ['gpt-6.1-terra', 'text-embedding-3-small']], ['anthropic', '2026-10-01', ['claude-haiku-5-5']], ['google', '2026-10-01', ['gemini-3.5-flash-lite']]];

test('the first run of a month stores each provider\'s list and emails the models that are new in the families the app uses; a second run that month does nothing', async () => {
  const { table, sent, adapters, watch } = world({ stored: LAST_MONTH });
  const first = await watch(NOV_21);
  assert.equal(first.ran, true);
  assert.deepEqual(table.rows.filter(row => row.month === '2026-11-01').map(row => row.provider).sort(), ['anthropic', 'google', 'openai']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'NYCInjury.ai: what changed in the providers\' model lists this month');
  assert.match(sent[0].html, /gpt-6-luna/);
  assert.match(sent[0].html, /claude-opus-5-5/);
  assert.match(sent[0].html, /gemini-3\.8-flash/);
  assert.doesNotMatch(sent[0].html, /text-embedding/);
  assert.match(sent[0].html, /Nothing has been switched/);
  const asked = Object.values(adapters).map(adapter => adapter.asked);
  const second = await watch(new Date('2026-11-22T14:00:00Z'));
  assert.deepEqual(second, { ran: false });
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.values(adapters).map(adapter => adapter.asked), asked);
});

test('a model in the chains or the defaults that its provider no longer lists is named, and so is one that is new', async () => {
  const { sent, watch } = world({ stored: LAST_MONTH, lists: { ...LISTS, anthropic: ['claude-opus-5-5'] } });
  await watch(NOV_21);
  assert.equal(sent.length, 1);
  assert.match(sent[0].html, /claude-haiku-5-5[^<]*(is|are) no longer listed/);
  assert.match(sent[0].html, /claude-opus-5-5/);
});

test('with no list from an earlier month, the first look stores the lists and claims nothing is new', async () => {
  const { table, sent, watch } = world();
  await watch(NOV_21);
  assert.equal(table.rows.length, 3);
  assert.equal(sent.length, 1);
  assert.match(sent[0].html, /first look/);
  assert.doesNotMatch(sent[0].html, /gpt-6-luna/);
});

test('a model that retires 60, 30 or 7 days away sends one email each, and day 59 sends none', async () => {
  const stored = [['openai', '2026-11-01', LISTS.openai], ['anthropic', '2026-11-01', LISTS.anthropic], ['google', '2026-11-01', LISTS.google]];
  const inUse = [...IN_USE, 'gpt-4o'];
  for (const [day, away] of [['2026-11-15', 60], ['2026-12-15', 30], ['2027-01-07', 7]]) {
    const { sent, watch } = world({ stored: [...stored, ...stored.map(([provider, , models]) => [provider, `${day.slice(0, 7)}-01`, models])], inUse });
    assert.deepEqual(await watch(new Date(`${day}T15:00:00Z`)), { ran: false, email: `NYCInjury.ai: gpt-4o retires in ${away} days` }, day);
    assert.equal(sent.length, 1, day);
    assert.match(sent[0].html, /gpt-4o/);
    assert.match(sent[0].html, /2027-01-14/);
  }
  const { sent, watch } = world({ stored: [...stored, ...stored.map(([provider, , models]) => [provider, '2026-11-01', models])], inUse });
  assert.deepEqual(await watch(new Date('2026-11-16T15:00:00Z')), { ran: false });
  assert.deepEqual(sent, []);
});

test('a model that is in no chain and no default is not reminded of, whatever its retirement date', async () => {
  const stored = [['openai', '2026-11-01', LISTS.openai], ['anthropic', '2026-11-01', LISTS.anthropic], ['google', '2026-11-01', LISTS.google]];
  const { sent, watch } = world({ stored });
  await watch(new Date('2026-11-15T15:00:00Z'));
  assert.deepEqual(sent, []);
});

test('a reminder and the monthly email that fall on the same night are one email', async () => {
  // 1 December is the first night of the month but 44 days from the retirement, so it sends the monthly email alone;
  // 15 December is 30 days from it, and the watch has not yet run that month, so the two fall on one night.
  const { sent, watch } = world({ stored: LAST_MONTH.map(([provider, , models]) => [provider, '2026-11-01', models]), inUse: [...IN_USE, 'gpt-4o'] });
  const result = await watch(new Date('2026-12-01T15:00:00Z'));
  assert.equal(sent.length, 1);
  assert.equal(result.ran, true);
  const later = world({ stored: LAST_MONTH.map(([provider, , models]) => [provider, '2026-11-01', models]), inUse: [...IN_USE, 'gpt-4o'] });
  const combined = await later.watch(new Date('2026-12-15T15:00:00Z'));
  assert.equal(combined.ran, true);
  assert.equal(later.sent.length, 1);
  assert.match(later.sent[0].html, /gpt-4o/);
  assert.match(later.sent[0].html, /30 days/);
  assert.match(later.sent[0].html, /gpt-6-luna/);
});

test('the day and the month are New York\'s: a night just after midnight in Greenwich is still the day before', async () => {
  const { table, watch } = world({ stored: LAST_MONTH });
  await watch(new Date('2026-12-01T03:00:00Z'));
  assert.deepEqual([...new Set(table.rows.filter(row => row.month > '2026-10-01').map(row => row.month))], ['2026-11-01']);
});

test('a provider whose list cannot be read is named in the email without its key, is not stored, and is tried again the next night', async () => {
  const unreadable = new Error('Incorrect API key provided: sk-abcdefghijklmnop1234');
  const { table, sent, adapters, watch } = world({ stored: LAST_MONTH, lists: { ...LISTS, anthropic: unreadable } });
  const first = await watch(NOV_21);
  assert.equal(first.ran, true);
  assert.deepEqual(table.rows.filter(row => row.month === '2026-11-01').map(row => row.provider).sort(), ['google', 'openai']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].html, /anthropic[^<]*could not be read/);
  assert.doesNotMatch(sent[0].html, /sk-abcdefghijklmnop1234/);
  assert.match(sent[0].html, /gpt-6-luna/);
  // The next night: only Anthropic is asked, and this time it answers.
  Object.assign(adapters.anthropic, { async listModels() { adapters.anthropic.asked += 1; return LISTS.anthropic; } });
  const asked = Object.fromEntries(Object.entries(adapters).map(([name, adapter]) => [name, adapter.asked]));
  const second = await watch(new Date('2026-11-22T14:00:00Z'));
  assert.equal(second.ran, true);
  assert.equal(adapters.openai.asked, asked.openai);
  assert.equal(adapters.google.asked, asked.google);
  assert.equal(adapters.anthropic.asked, asked.anthropic + 1);
  assert.equal(table.rows.filter(row => row.month === '2026-11-01').length, 3);
  assert.equal(sent.length, 2);
  assert.match(sent[1].html, /claude-opus-5-5/);
});

test('a model whose provider has no key is named once as not checked, and is not said to have vanished', async () => {
  const { sent, adapters, watch } = world({ stored: LAST_MONTH, keyed: ['openai', 'google'] });
  await watch(NOV_21);
  assert.equal(Object.keys(adapters).includes('anthropic'), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].html, /not checked: no key[^<]*claude-haiku-5-5/);
  assert.doesNotMatch(sent[0].html, /no longer listed/);
});

test('with the table missing, the email says so, nothing is stored, and a retirement reminder still goes out', async () => {
  const { table, sent, watch } = world({ inUse: [...IN_USE, 'gpt-4o'] });
  table.gone();
  const result = await watch(new Date('2026-12-15T15:00:00Z'));
  assert.equal(result.ran, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].html, /provider_model_lists/);
  assert.match(sent[0].html, /npm run setup-db/);
  assert.match(sent[0].html, /gpt-4o/);
});
