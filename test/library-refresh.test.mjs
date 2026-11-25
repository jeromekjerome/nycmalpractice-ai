// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The nightly refresh of the case library (library-refresh.js): which topics run and in what order, how many requests it may
// send, what it does when CourtListener answers with trouble, and how the pinned decisions are looked up once. The searches,
// the citation lookup and the usage report are fakes, the clock is a counter and nothing sleeps; the database is a fake that
// keeps rows in arrays. Nothing here reaches a network or a database.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from './runner.mjs';
import { refreshLibrary, recordFromCluster } from '../library-refresh.js';

const LOOKUP = JSON.parse(readFileSync(new URL('./fixtures/cl-citation-lookup.json', import.meta.url), 'utf8'));
const PINS = [
  { citation: '31 N.Y.3d 312', name: 'Rodriguez v. City of New York' },
  { citation: '57 N.Y.2d 230', name: 'Licari v. Elliott' },
];
const PLENTY = { day: 125, hour: 50, minute: 5 };

// A database that keeps what the refresh writes: the topics' last runs, the saved decisions, the pinned ones.
function fakeDb({ lastRuns = {}, stale = 0 } = {}) {
  const db = { lastRuns: new Map(Object.entries(lastRuns)), saved: [], pinned: [], topicWrites: [], deletes: 0, queries: [] };
  db.sql = async (strings, ...values) => {
    const text = strings.join('?');
    db.queries.push(text);
    if (/SELECT topic_id, last_run_at FROM library_topics/.test(text)) return [...db.lastRuns].map(([topic_id, last_run_at]) => ({ topic_id, last_run_at }));
    if (/INSERT INTO library_topics/.test(text)) {
      db.lastRuns.set(values[0], new Date().toISOString());
      db.topicWrites.push({ id: values[0], found: values[1] });
      return [];
    }
    if (/INSERT INTO case_library .*'\{\}', '\{\}', TRUE\)/s.test(text)) {
      db.pinned.push({ cluster_id: values[0], opinion_id: values[1], case_name: values[3], citations: JSON.parse(values[4]), court_id: values[6] });
      return [];
    }
    if (/INSERT INTO case_library/.test(text)) {
      db.saved.push({ cluster_id: values[0], case_types: values[10], topics: values[11] });
      return [];
    }
    if (/SELECT citations FROM case_library WHERE pinned = TRUE/.test(text)) return db.pinned.map(row => ({ citations: row.citations }));
    if (/DELETE FROM case_library/.test(text)) { db.deletes += 1; return Array.from({ length: stale }, (_, i) => ({ cluster_id: i + 1 })); }
    throw new Error(`Unexpected query: ${text}`);
  };
  return db;
}

// A search that answers each topic with `count` results, or the status given for it. Cluster ids run from 1000 for each topic.
function fakeSearch({ count = 3, statusFor = {}, costMs = 0, clock } = {}) {
  const asked = [];
  const search = async ({ q }) => {
    asked.push(q);
    if (clock) clock.t += costMs;
    const status = statusFor[q] ?? 200;
    if (status !== 200) return { results: [], status };
    const base = 1000 * asked.length;
    return { status, results: Array.from({ length: count }, (_, i) => ({ cluster_id: base + i, caseName: `${q} v. Case ${i}`, citation: [], opinions: [] })) };
  };
  return { search, asked };
}

// A clock that moves only when the refresh sleeps, and a sleep that records.
function fakeClock() {
  const clock = { t: 0, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async ms => { clock.sleeps.push(ms); clock.t += ms; };
  return clock;
}

const lookupFromFixture = () => {
  const asked = [];
  const lookupPins = async ({ text }) => {
    asked.push(text);
    const wanted = text.split('\n');
    return { status: 200, body: LOOKUP.filter(entry => wanted.includes(entry.citation)) };
  };
  return { lookupPins, asked };
};

const THREE = { auto: [{ id: 'auto-a', q: 'alpha' }, { id: 'auto-b', q: 'bravo' }], slip: [{ id: 'slip-c', q: 'charlie' }] };

function run(overrides) {
  const clock = overrides.clock || fakeClock();
  return refreshLibrary({ topics: THREE, pins: [], allowance: async () => PLENTY, now: clock.now, sleep: clock.sleep, lookupPins: async () => { throw new Error('no lookup expected'); }, ...overrides });
}

test('the topics run oldest first, never-run ones before any that has run, and the best results of each are saved', async () => {
  const db = fakeDb({ lastRuns: { 'auto-a': '2026-11-24T22:00:00Z', 'slip-c': '2026-11-20T22:00:00Z' } });
  const { search, asked } = fakeSearch({ count: 5 });
  const clock = fakeClock();
  const result = await run({ sqlClient: db.sql, search, perTopic: 2, clock });
  assert.deepEqual(asked, ['bravo', 'charlie', 'alpha']);
  assert.deepEqual(result, { searched: ['auto-b', 'slip-c', 'auto-a'], added: 6, dropped: 0, pinsResolved: 0, stoppedBecause: null });
  assert.equal(db.saved.length, 6, 'perTopic caps what is kept');
  assert.deepEqual(db.saved.slice(0, 2).map(row => [row.case_types[0], row.topics[0]]), [['auto', 'auto-b'], ['auto', 'auto-b']]);
  assert.deepEqual(db.topicWrites, [{ id: 'auto-b', found: 2 }, { id: 'slip-c', found: 2 }, { id: 'auto-a', found: 2 }]);
  assert.deepEqual(clock.sleeps, [13000, 13000], 'the requests are spaced, and nothing waits before the first');
});

test('a topic that finds nothing is still marked as run', async () => {
  const db = fakeDb();
  const { search } = fakeSearch({ count: 0 });
  const result = await run({ sqlClient: db.sql, search, topics: { auto: [{ id: 'auto-a', q: 'alpha' }] } });
  assert.deepEqual(db.topicWrites, [{ id: 'auto-a', found: 0 }]);
  assert.equal(result.added, 0);
});

test('a result with no case name is dropped from the top results, not counted', async () => {
  const db = fakeDb();
  const search = async () => ({ status: 200, results: [{ cluster_id: 1, caseName: '' }, { cluster_id: 2, caseName: 'Real v. Case' }] });
  const result = await run({ sqlClient: db.sql, search, topics: { auto: [{ id: 'auto-a', q: 'alpha' }] } });
  assert.equal(result.added, 1);
  assert.deepEqual(db.saved.map(row => row.cluster_id), [2]);
});

test('the run stops at the most searches it may send', async () => {
  const db = fakeDb();
  const { search, asked } = fakeSearch();
  const result = await run({ sqlClient: db.sql, search, maxSearches: 2 });
  assert.equal(asked.length, 2);
  assert.equal(result.searched.length, 2);
  assert.equal(result.stoppedBecause, null);
});

test('no request is sent when the allowance has nothing to spare, or cannot be read', async () => {
  for (const answer of [{ day: 30, hour: 50, minute: 5 }, { day: 125, hour: 5, minute: 5 }, null]) {
    const db = fakeDb();
    const { search, asked } = fakeSearch();
    const result = await run({ sqlClient: db.sql, search, allowance: async () => answer, pins: PINS, lookupPins: async () => { throw new Error('asked'); } });
    assert.deepEqual(result, { searched: [], added: 0, dropped: 0, pinsResolved: 0, stoppedBecause: 'allowance' }, JSON.stringify(answer));
    assert.equal(asked.length, 0);
    assert.equal(db.queries.length, 0, 'nothing was read or written');
  }
});

test('the allowance is asked once, and what it leaves less its reserve caps the requests: the pin lookup first, then the searches', async () => {
  const db = fakeDb();
  const { search, asked } = fakeSearch();
  let allowanceAsked = 0;
  const { lookupPins, asked: lookups } = lookupFromFixture();
  const result = await run({
    sqlClient: db.sql, search, pins: PINS, lookupPins, allowance: async () => { allowanceAsked += 1; return { day: 32, hour: 50, minute: 5 }; },
  });
  assert.equal(allowanceAsked, 1);
  assert.equal(lookups.length, 1, 'the pins are looked up first');
  assert.equal(asked.length, 1, 'two requests are left above the reserve, and the lookup spent one');
  assert.equal(result.stoppedBecause, 'allowance');
  assert.equal(result.pinsResolved, 2);
});

test('the pins are looked up before the searches, whatever the number of topics, and then exactly maxSearches searches follow', async () => {
  const db = fakeDb();
  const events = [];
  const search = async ({ q }) => { events.push(`search ${q}`); return { status: 200, results: [] }; };
  const { lookupPins } = lookupFromFixture();
  const topics = { auto: Array.from({ length: 12 }, (_, i) => ({ id: `auto-${i}`, q: `topic${i}` })) };
  const result = await run({
    sqlClient: db.sql, search, topics, pins: PINS, maxSearches: 3,
    lookupPins: async args => { events.push('lookup'); return lookupPins(args); },
  });
  assert.deepEqual(events, ['lookup', 'search topic0', 'search topic1', 'search topic2']);
  assert.equal(result.pinsResolved, 2);
  assert.equal(db.pinned.length, 2);
  assert.equal(result.searched.length, 3);
  assert.equal(result.stoppedBecause, null);
});

test('a lookup that answers with trouble leaves the pins unresolved, is named in a warning, and the searches still run', async () => {
  for (const status of [429, 0]) {
    const db = fakeDb();
    const { search, asked } = fakeSearch();
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    let result;
    try {
      result = await run({ sqlClient: db.sql, search, pins: PINS, lookupPins: async () => ({ status, body: null }) });
    } finally {
      console.warn = realWarn;
    }
    assert.equal(result.pinsResolved, 0);
    assert.equal(result.searched.length, 3);
    assert.equal(asked.length, 3);
    assert.equal(db.pinned.length, 0);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(String(status)), warnings[0]);
  }
});

test('the run stops with time past its budget, keeping the rows written', async () => {
  const db = fakeDb();
  const clock = fakeClock();
  const { search, asked } = fakeSearch({ costMs: 5000, clock });
  const result = await run({ sqlClient: db.sql, search, clock, budgetMs: 30000, spacingMs: 13000 });
  assert.equal(asked.length, 2);
  assert.equal(result.stoppedBecause, 'time');
  assert.equal(result.added, 6);
  assert.equal(db.saved.length, 6);
  assert.equal(db.topicWrites.length, 2);
});

test('a throttled, failing or unreachable answer stops the run and throws, leaving the rows written and that topic as it was', async () => {
  for (const status of [429, 500, 0]) {
    const db = fakeDb();
    const { search, asked } = fakeSearch({ statusFor: { bravo: status } });
    const { lookupPins, asked: lookups } = lookupFromFixture();
    await assert.rejects(run({ sqlClient: db.sql, search, lookupPins }), new RegExp(`^Error: CourtListener answered ${status} to the topic search auto-b; the run stopped$`));
    assert.deepEqual(asked, ['alpha', 'bravo'], 'no further search was sent');
    assert.equal(db.saved.length, 3, 'the first topic stays written');
    assert.deepEqual(db.topicWrites.map(write => write.id), ['auto-a']);
    assert.equal(db.deletes, 0, 'no stale row is dropped that night');
    assert.equal(lookups.length, 0);
    assert.ok(!db.queries.some(text => /screen_state =|pinned = TRUE\b.*DO UPDATE/s.test(text)), 'no row changed its state');
  }
});

test('stale rows are dropped after the searches, and counted', async () => {
  const db = fakeDb({ stale: 4 });
  const { search } = fakeSearch();
  const result = await run({ sqlClient: db.sql, search });
  assert.equal(result.dropped, 4);
  assert.equal(db.deletes, 1);
});

test('the pinned decisions are looked up in one request, kept pinned with no case type, and not looked up again', async () => {
  const db = fakeDb();
  const { search } = fakeSearch();
  const { lookupPins, asked } = lookupFromFixture();
  const clock = fakeClock();
  const first = await run({ sqlClient: db.sql, search, pins: PINS, lookupPins, clock });
  assert.equal(first.pinsResolved, 2);
  assert.deepEqual(asked, ['31 N.Y.3d 312\n57 N.Y.2d 230']);
  assert.equal(db.pinned.length, 2);
  const rodriguez = db.pinned.find(row => row.cluster_id === 7173717);
  assert.equal(rodriguez.opinion_id, 7084086);
  assert.equal(rodriguez.court_id, 'ny');
  assert.deepEqual(rodriguez.citations, ['101 N.E.3d 366', '31 N.Y.3d 312', '76 N.Y.S.3d 898']);
  assert.deepEqual(clock.sleeps, [13000, 13000, 13000], 'the lookup waits the spacing like a search');
  const second = await run({ sqlClient: db.sql, search, pins: PINS, lookupPins });
  assert.equal(second.pinsResolved, 0);
  assert.equal(asked.length, 1, 'a resolved pin is not looked up again');
});

test('a pin the lookup does not find stays unresolved, is named once in a warning, and is asked for again the next night', async () => {
  const db = fakeDb();
  const { search } = fakeSearch();
  const { lookupPins, asked } = lookupFromFixture();
  const pins = [...PINS, { citation: '1 N.Y.9d 999', name: 'Nobody v. Nowhere' }];
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.equal((await run({ sqlClient: db.sql, search, pins, lookupPins })).pinsResolved, 2);
    assert.equal((await run({ sqlClient: db.sql, search, pins, lookupPins })).pinsResolved, 0);
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(asked, ['31 N.Y.3d 312\n57 N.Y.2d 230\n1 N.Y.9d 999', '1 N.Y.9d 999']);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(line => line.includes('1 N.Y.9d 999')), warnings.join('\n'));
});

test('a pin counts as resolved when a pinned row holds its citation, however it is spaced or cased', async () => {
  const db = fakeDb();
  db.pinned.push({ cluster_id: 5, citations: ['31  n.y.3d  312'] });
  const { search } = fakeSearch();
  const { lookupPins, asked } = lookupFromFixture();
  const result = await run({ sqlClient: db.sql, search, pins: PINS, lookupPins });
  assert.deepEqual(asked, ['57 N.Y.2d 230']);
  assert.equal(result.pinsResolved, 1);
});

test('of several clusters for one citation, the one whose name shares the most words with the pin wins, the first on a tie', async () => {
  const db = fakeDb();
  const { search } = fakeSearch();
  const clusters = [
    { id: 1, case_name: 'Unrelated v. Other', citations: [{ volume: '31', reporter: 'N.Y.3d', page: '312' }], sub_opinions: [] },
    { id: 2, case_name: 'Rodriguez v. City of N.Y.', citations: [{ volume: '31', reporter: 'N.Y.3d', page: '312' }], sub_opinions: [] },
    { id: 3, case_name: 'Rodriguez v. City of N.Y.', citations: [{ volume: '31', reporter: 'N.Y.3d', page: '312' }], sub_opinions: [] },
  ];
  const lookupPins = async () => ({ status: 200, body: [{ citation: '31 N.Y.3d 312', normalized_citations: ['31 N.Y.3d 312'], status: 200, clusters }] });
  await run({ sqlClient: db.sql, search, pins: [PINS[0]], lookupPins });
  assert.deepEqual(db.pinned.map(row => row.cluster_id), [2]);
});

test('an entry the lookup answered with another status resolves nothing', async () => {
  const db = fakeDb();
  const { search } = fakeSearch();
  const lookupPins = async () => ({ status: 200, body: [{ citation: '31 N.Y.3d 312', normalized_citations: [], status: 404, clusters: [] }] });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await run({ sqlClient: db.sql, search, pins: [PINS[0]], lookupPins })).pinsResolved, 0);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(db.pinned.length, 0);
});

test('a cluster becomes a record: ids, citations, the Court of Appeals by its reporter, and nothing without an id or a name', () => {
  const rodriguez = recordFromCluster(LOOKUP[0].clusters[0]);
  assert.deepEqual(rodriguez, {
    cluster_id: 7173717, opinion_id: 7084086, docket_id: 64162082, case_name: 'Rodriguez v. City of N.Y.', citations: ['101 N.E.3d 366', '31 N.Y.3d 312', '76 N.Y.S.3d 898'],
    court: 'New York Court of Appeals', court_id: 'ny', date_filed: '2018-04-03', snippet: '', url: 'https://www.courtlistener.com/opinion/7173717/rodriguez-v-city-of-ny/',
  });
  const other = recordFromCluster({ ...LOOKUP[0].clusters[0], citations: [{ volume: '216', reporter: 'A.D.3d', page: '726' }], date_filed: 'soon' });
  assert.deepEqual([other.court, other.court_id, other.date_filed], [null, null, null]);
  assert.equal(recordFromCluster({ ...LOOKUP[0].clusters[0], id: undefined }), null);
  assert.equal(recordFromCluster({ ...LOOKUP[0].clusters[0], case_name: ' ' }), null);
  assert.equal(recordFromCluster(null), null);
});
