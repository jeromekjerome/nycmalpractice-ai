// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The library's records (case-library.js): a search result becomes a record, found records are kept with their case types and
// topics, stale ones are dropped, and a reply's decisions are picked from the clear ones. The SQL client is a fake that answers
// from an array; nothing here reaches a database or a network.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from './runner.mjs';
import {
  recordFromResult, saveFound, savePinned, pinnedCitations, dropStale, pickDecisions, clearCount, bannedIds, screenStates, shownScreen, libraryCounts,
  dueForScreen, recordTried, recordClear, recordHeld, heldDecisions, decideHeld,
} from '../case-library.js';

const RESULT = JSON.parse(readFileSync(new URL('./fixtures/cl-search-result.json', import.meta.url), 'utf8'));

// A fake Neon client: it reads the query text, and keeps the rows the way the table would.
function fakeLibrary(rows = []) {
  const queries = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?');
    queries.push({ text, values });
    // The screen's statements: the due rows are what the test put in (their order is the real database's, checked by the
    // PGlite check), and a write changes a row only while it is unscreened or clear.
    // The owner's list and decisions: the held rows (their order is the real database's, checked by the PGlite check), and a
    // write that changes a row only while it is held.
    if (/FROM case_library\s+WHERE screen_state = 'held'/.test(text)) return rows.filter(r => r.screen_state === 'held');
    // The owner's clear sends a hold with no answered question (unreadable, or none named) back to be screened.
    const decided = /^\s*UPDATE case_library SET\s+screen_state = (?:'(banned)'|CASE WHEN COALESCE\(hold->>'question', 'unreadable'\) = 'unreadable' THEN 'unscreened' ELSE 'clear' END).*AND screen_state = 'held'/s.exec(text);
    if (decided) {
      const found = rows.find(r => Number(r.cluster_id) === Number(values.at(-1)));
      if (!found || found.screen_state !== 'held') return [];
      if (decided[1]) Object.assign(found, { screen_state: 'banned', decided_at: values[0] });
      else if ((found.hold?.question ?? 'unreadable') === 'unreadable') Object.assign(found, { screen_state: 'unscreened', screened_at: null, decided_at: null });
      else Object.assign(found, { screen_state: 'clear', screened_at: values[0], decided_at: values[1] });
      return [{ cluster_id: String(found.cluster_id) }];
    }
    if (/FROM case_library\s+WHERE opinion_id IS NOT NULL/.test(text)) return rows.slice(0, values.at(-1));
    if (/^\s*UPDATE case_library SET screen_tried_at/.test(text)) return [];
    if (/^\s*UPDATE case_library SET screen_state = '(clear|held)'/.test(text)) {
      const found = rows.find(r => Number(r.cluster_id) === Number(values.at(-1)));
      return found && ['unscreened', 'clear'].includes(found.screen_state) ? [{ cluster_id: String(found.cluster_id) }] : [];
    }
    if (/INSERT INTO case_library .*'\{\}', '\{\}', TRUE\)/s.test(text)) {
      const [clusterId, , , name, citations] = values;
      const found = rows.find(r => Number(r.cluster_id) === Number(clusterId));
      if (found) {
        found.pinned = true;
        found.last_found = 'now';
        if (JSON.parse(citations).length) found.citations = JSON.parse(citations);
      } else {
        rows.push({ cluster_id: clusterId, case_name: name, citations: JSON.parse(citations), case_types: [], topics: [], pinned: true, screen_state: 'unscreened', last_found: 'now' });
      }
      return [];
    }
    if (/SELECT citations FROM case_library WHERE pinned = TRUE/.test(text)) return rows.filter(r => r.pinned).map(r => ({ citations: r.citations }));
    if (/INSERT INTO case_library/.test(text)) {
      const [clusterId, , , name, , , , , , , types, topics] = values;
      const found = rows.find(r => Number(r.cluster_id) === Number(clusterId));
      const union = (a, b) => [...new Set([...a, ...b])];
      if (found) {
        found.case_types = union(found.case_types, types);
        found.topics = union(found.topics, topics);
        found.last_found = 'now';
      } else {
        rows.push({ cluster_id: clusterId, case_name: name, case_types: types, topics, pinned: false, screen_state: 'unscreened', last_found: 'now' });
      }
      return [];
    }
    if (/DELETE FROM case_library/.test(text)) {
      const keepsHeld = /screen_state <> 'held'/.test(text);
      const gone = rows.filter(r => !r.pinned && r.screen_state !== 'banned' && !(keepsHeld && r.screen_state === 'held') && r.stale);
      for (const row of gone) rows.splice(rows.indexOf(row), 1);
      return gone.map(r => ({ cluster_id: r.cluster_id }));
    }
    if (/SELECT COUNT\(\*\)::int AS n FROM case_library WHERE screen_state = 'clear'/.test(text)) {
      const unpinned = /pinned = FALSE/.test(text);
      return [{ n: String(rows.filter(r => r.screen_state === 'clear' && !(unpinned && r.pinned) && r.case_types.includes(values[0])).length) }];
    }
    if (/screen_state = 'clear' AND/.test(text)) {
      const unpinned = /pinned = FALSE/.test(text);
      return rows.filter(r => r.screen_state === 'clear' && !(unpinned && r.pinned) && r.case_types.includes(values[0]));
    }
    if (/WHERE screen_state = 'banned'/.test(text)) return rows.filter(r => r.screen_state === 'banned').map(r => ({ cluster_id: String(r.cluster_id) }));
    if (/cluster_id = ANY/.test(text)) {
      const wanted = values[0].map(Number);
      return rows.filter(r => wanted.includes(Number(r.cluster_id)))
        .map(r => ({ cluster_id: String(r.cluster_id), screen_state: r.screen_state, screened_at: r.screened_at ?? null, screened_on: r.screened_on ?? null, question: r.hold?.question ?? null }));
    }
    if (/unnest\(case_types\)/.test(text)) {
      const out = [];
      for (const row of rows) if (!(/pinned = FALSE/.test(text) && row.pinned)) for (const type of row.case_types) out.push({ case_type: type, screen_state: row.screen_state });
      const counts = new Map();
      for (const o of out) counts.set(`${o.case_type}|${o.screen_state}`, (counts.get(`${o.case_type}|${o.screen_state}`) || 0) + 1);
      return [...counts].map(([key, n]) => { const [case_type, screen_state] = key.split('|'); return { case_type, screen_state, n }; });
    }
    if (/GROUP BY screen_state, pinned/.test(text)) {
      const counts = new Map();
      for (const row of rows) counts.set(`${row.screen_state}|${Boolean(row.pinned)}`, (counts.get(`${row.screen_state}|${Boolean(row.pinned)}`) || 0) + 1);
      return [...counts].map(([key, n]) => { const [screen_state, pinned] = key.split('|'); return { screen_state, pinned: pinned === 'true', n }; });
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  return { sql, rows, queries };
}

const flat = text => text.replace(/\s+/g, ' ').trim();

const clearRow = (id, name, date, extra = {}) => ({
  cluster_id: String(id), opinion_id: '1', docket_id: '2', case_name: name, citations: [`${id} A.D.3d 1`, `${id} N.Y.S.3d 2`], court: 'Appellate Division',
  court_id: 'nyappdiv', date_filed: date, snippet: '', url: `https://www.courtlistener.com/opinion/${id}/x/`,
  case_types: ['auto'], topics: [], pinned: false, screen_state: 'clear', screened_at: '2026-11-23T05:00:00Z', screened_on: '2026-11-23', ...extra,
});

test('a search result becomes a record with its ids, three citations and a plain snippet', () => {
  const record = recordFromResult(RESULT);
  assert.equal(record.cluster_id, 9398198);
  assert.equal(record.opinion_id, 9393674);
  assert.equal(record.docket_id, 67360846);
  assert.equal(record.case_name, 'Bello v. Masters Auto Collision of Long Is., Inc.');
  assert.deepEqual(record.citations, ['216 A.D.3d 726', '188 N.Y.S.3d 177', '2023 NY Slip Op 02489']);
  assert.equal(record.court_id, 'nyappdiv');
  assert.equal(record.date_filed, '2023-05-10');
  assert.equal(record.url, 'https://www.courtlistener.com/opinion/9398198/bello-v-masters-auto-collision-of-long-is-inc/');
  assert.ok(record.snippet.length > 0 && record.snippet.length <= 600);
  assert.ok(!/\n/.test(record.snippet));
});

test('marks are stripped from the snippet and it is cut at 600 characters', () => {
  const record = recordFromResult({ ...RESULT, opinions: [{ id: 5, snippet: `a <mark>rear-end</mark> ${'x'.repeat(900)}` }] });
  assert.ok(record.snippet.startsWith('a rear-end x'));
  assert.equal(record.snippet.length, 600);
  assert.equal(recordFromResult({ ...RESULT, opinions: [], snippet: '<mark>top</mark> level' }).snippet, 'top level');
});

test('a result with no cluster id or no case name is not a record', () => {
  assert.equal(recordFromResult({ ...RESULT, cluster_id: undefined }), null);
  assert.equal(recordFromResult({ ...RESULT, caseName: '  ' }), null);
  assert.equal(recordFromResult(null), null);
});

test('a filing date that is not YYYY-MM-DD is kept as null, so one bad date cannot stop a save', () => {
  assert.equal(recordFromResult({ ...RESULT, dateFiled: 'May 10, 2023' }).date_filed, null);
  assert.equal(recordFromResult({ ...RESULT, dateFiled: '2023-05-10T00:00:00Z' }).date_filed, null);
  assert.equal(recordFromResult({ ...RESULT, dateFiled: undefined }).date_filed, null);
  assert.equal(recordFromResult({ ...RESULT, dateFiled: '2023-05-10' }).date_filed, '2023-05-10');
});

test('a pinned record is saved with no case type or topic, and a decision already held is pinned without its screen state changing', async () => {
  const world = fakeLibrary([clearRow(9398198, 'Bello', '2023-05-10', { screen_state: 'held', case_types: ['auto'] })]);
  const record = recordFromResult(RESULT);
  assert.equal(await savePinned(world.sql, [record, { ...record, cluster_id: 77, case_name: 'Pinned v. New', citations: ['1 N.Y.3d 1'] }]), 2);
  const found = world.rows.find(r => r.cluster_id === '9398198');
  assert.equal(found.pinned, true);
  assert.equal(found.screen_state, 'held');
  const added = world.rows.find(r => r.cluster_id === 77);
  assert.deepEqual([added.pinned, added.case_types, added.topics, added.screen_state], [true, [], [], 'unscreened']);
  const update = world.queries[0].text.split('DO UPDATE')[1];
  assert.ok(update && !/screen_state|screened_at|hold|decided_at|case_types|topics/.test(update), update);
  assert.deepEqual((await pinnedCitations(world.sql)).sort(), ['1 N.Y.3d 1', '188 N.Y.S.3d 177', '2023 NY Slip Op 02489', '216 A.D.3d 726']);
  assert.equal(await savePinned(world.sql, []), 0);
});

test('a pinned decision found by a topic search is neither picked for a reply nor counted', async () => {
  const world = fakeLibrary([
    clearRow(1, 'Pinned v. Auto', '2024-01-01', { pinned: true, snippet: 'rear-end collision' }),
    clearRow(2, 'Plain v. Auto', '2023-01-01', { snippet: 'rear-end collision' }),
  ]);
  assert.deepEqual((await pickDecisions(world.sql, { caseType: 'auto', terms: 'rear-end collision' })).map(d => d.clusterId), [2]);
  assert.equal(await clearCount(world.sql, 'auto'), 1);
});

test('the same decision found for two topics keeps both case types and both topics', async () => {
  const world = fakeLibrary();
  const record = recordFromResult(RESULT);
  assert.equal(await saveFound(world.sql, [record], { caseType: 'auto', topicId: 'auto-rear-end' }), 1);
  assert.equal(await saveFound(world.sql, [record], { caseType: 'slip', topicId: 'slip-ice' }), 1);
  assert.equal(world.rows.length, 1);
  assert.deepEqual(world.rows[0].case_types.sort(), ['auto', 'slip']);
  assert.deepEqual(world.rows[0].topics.sort(), ['auto-rear-end', 'slip-ice']);
});

test('finding a decision again never writes its screen state', async () => {
  const world = fakeLibrary([clearRow(9398198, 'Bello', '2023-05-10', { screen_state: 'banned' })]);
  await saveFound(world.sql, [recordFromResult(RESULT)], { caseType: 'auto', topicId: 'auto-rear-end' });
  assert.equal(world.rows[0].screen_state, 'banned');
  const update = world.queries[0].text.split('DO UPDATE')[1];
  assert.ok(update && !/screen_state|screened_at|hold|decided_at|pinned/.test(update), update);
});

test('saving nothing sends nothing', async () => {
  const world = fakeLibrary();
  assert.equal(await saveFound(world.sql, [], { caseType: 'auto', topicId: 't' }), 0);
  assert.equal(world.queries.length, 0);
});

test('stale rows are dropped but pinned, banned and held rows are kept', async () => {
  const world = fakeLibrary([
    clearRow(1, 'Old one', '2020-01-01', { stale: true }),
    clearRow(2, 'Old pinned', '2020-01-01', { stale: true, pinned: true }),
    clearRow(3, 'Old banned', '2020-01-01', { stale: true, screen_state: 'banned' }),
    clearRow(4, 'Recent', '2020-01-01'),
    clearRow(5, 'Old held', '2020-01-01', { stale: true, screen_state: 'held' }),
  ]);
  assert.equal(await dropStale(world.sql, { days: 90 }), 1);
  assert.deepEqual(world.rows.map(r => r.cluster_id), ['2', '3', '4', '5']);
  const text = world.queries[0].text;
  assert.match(text, /pinned = FALSE/);
  assert.match(text, /screen_state <> 'banned'/);
  assert.match(text, /screen_state <> 'held'/);
  assert.equal(world.queries[0].values[0], 90);
});

test('a reply gets at most five clear decisions, best overlap first and the newer first on a tie', async () => {
  const world = fakeLibrary([
    clearRow(1, 'Smith v. Jones', '2024-01-01', { snippet: 'a rear-end collision on the highway' }),
    clearRow(2, 'Doe v. Roe', '2022-01-01', { snippet: 'rear-end collision' }),
    clearRow(3, 'Poe v. Moe', '2025-01-01', { snippet: 'rear-end collision' }),
    clearRow(4, 'Held v. Case', '2025-06-01', { snippet: 'rear-end collision on the highway', screen_state: 'held' }),
    clearRow(5, 'Plain v. Name', '2023-01-01', { snippet: 'unrelated matter' }),
    clearRow(6, 'Topic v. Match', '2021-01-01', { topics: ['auto-highway'] }),
    clearRow(7, 'Other v. Type', '2025-01-01', { snippet: 'rear-end collision on the highway', case_types: ['slip'] }),
    clearRow(8, 'Extra v. One', '2019-01-01', { snippet: 'something' }),
  ]);
  const picked = await pickDecisions(world.sql, { caseType: 'auto', terms: 'rear-end collision on the highway', limit: 5 });
  assert.equal(picked.length, 5);
  assert.deepEqual(picked.map(d => d.clusterId), [1, 3, 2, 6, 5]);
  assert.ok(!picked.some(d => d.clusterId === 4 || d.clusterId === 7));
});

test('a picked decision has the shape the reply and the citator use', async () => {
  const world = fakeLibrary([clearRow(11, 'Smith v. Jones', '2024-03-02', { snippet: 'text' })]);
  const [decision] = await pickDecisions(world.sql, { caseType: 'auto', terms: 'text' });
  assert.deepEqual(decision, {
    caseName: 'Smith v. Jones', citation: '11 A.D.3d 1', citations: ['11 A.D.3d 1', '11 N.Y.S.3d 2'], court: 'Appellate Division',
    dateFiled: '2024-03-02', snippet: 'text', url: 'https://www.courtlistener.com/opinion/11/x/', scope: 'library', clusterId: 11,
    screen: { state: 'clear', on: '2026-11-23' },
  });
});

test('a decision never screened has no screen date, and a picked one with no citations has an empty citation', async () => {
  const world = fakeLibrary([clearRow(12, 'No v. Cites', '2024-03-02', { citations: [], screened_on: null })]);
  const [decision] = await pickDecisions(world.sql, { caseType: 'auto', terms: '' });
  assert.equal(decision.citation, '');
  assert.deepEqual(decision.citations, []);
  assert.equal(decision.screen.on, null);
});

test('the counts: clear decisions of a type, banned ids, screen states, and the library totals', async () => {
  const world = fakeLibrary([
    clearRow(1, 'A', '2024-01-01'),
    clearRow(2, 'B', '2024-01-01', { screen_state: 'unscreened', screened_at: null, screened_on: null }),
    clearRow(3, 'C', '2024-01-01', { screen_state: 'held' }),
    clearRow(4, 'D', '2024-01-01', { screen_state: 'banned', case_types: ['slip'] }),
    // Pinned rows are left out of a type's counts, as a reply leaves them out, but are in the held, banned and total figures.
    clearRow(5, 'E', '2024-01-01', { pinned: true }),
    clearRow(6, 'F', '2024-01-01', { pinned: true, screen_state: 'held', case_types: [] }),
  ]);
  assert.equal(await clearCount(world.sql, 'auto'), 1);
  assert.deepEqual([...await bannedIds(world.sql)], [4]);
  const states = await screenStates(world.sql, [1, 2, 99]);
  assert.deepEqual([...states.keys()], [1, 2]);
  assert.equal(states.get(1).state, 'clear');
  assert.equal(states.get(2).screened_at, null);
  assert.equal((await screenStates(world.sql, [])).size, 0);
  assert.equal(states.get(1).question, null);
  assert.match(flat(world.queries.find(q => /cluster_id = ANY/.test(q.text)).text), /hold->>'question' AS question/);
  assert.deepEqual(await libraryCounts(world.sql), {
    byType: { auto: { clear: 1, unscreened: 1, held: 1 }, slip: { clear: 0, unscreened: 0, held: 0 } },
    held: 2, banned: 1, total: 6, pinned: 2,
  });
});

test('the state shown for a decision: clear with its day, held for the two real questions, and not screened for everything else', () => {
  const entry = (state, question = null, on = '2026-11-24') => ({ state, screened_at: null, on, question });
  assert.deepEqual(shownScreen(entry('clear')), { state: 'clear', on: '2026-11-24' });
  assert.deepEqual(shownScreen(entry('clear', 'citing')), { state: 'clear', on: '2026-11-24' });
  for (const state of ['held', 'banned']) {
    for (const question of ['citing', 'higher-court']) assert.deepEqual(shownScreen(entry(state, question)), { state: 'held', on: null }, `${state} ${question}`);
    assert.deepEqual(shownScreen(entry(state, 'unreadable')), { state: 'unscreened', on: null }, `${state} unreadable`);
    assert.deepEqual(shownScreen(entry(state)), { state: 'unscreened', on: null }, `${state} with no hold`);
  }
  assert.deepEqual(shownScreen(entry('unscreened', null, null)), { state: 'unscreened', on: null });
  assert.deepEqual(shownScreen(undefined), { state: 'unscreened', on: null });
});

test('the decisions due for the screen: those with an opinion id, never-screened first, then clear ones screened a month or more ago', async () => {
  const world = fakeLibrary([clearRow(1, 'A', '2024-01-01', { screen_state: 'unscreened' }), clearRow(2, 'B', '2024-01-01'), clearRow(3, 'C', '2024-01-01')]);
  const due = await dueForScreen(world.sql, { limit: 2, now: new Date('2026-11-25T23:00:00Z') });
  assert.deepEqual(due.map(row => row.cluster_id), ['1', '2']);
  const { values } = world.queries[0];
  const text = flat(world.queries[0].text);
  for (const column of ['cluster_id', 'opinion_id', 'case_name', 'citations', 'court', 'court_id', 'date_filed', 'url', 'screen_state', 'decided_at', 'hold']) {
    assert.match(text.split('FROM')[0], new RegExp(`\\b${column}\\b`), column);
  }
  assert.match(text, /to_char\(date_filed, 'YYYY-MM-DD'\) AS date_filed/);
  assert.match(text.split('FROM')[0], /\(screen_tried_at IS NOT NULL AND \(screened_at IS NULL OR screen_tried_at > screened_at\)\) AS last_try_failed/);
  const where = text.split('WHERE')[1].split('ORDER BY')[0];
  assert.match(where, /opinion_id IS NOT NULL/);
  assert.match(where, /screen_state = 'unscreened'/);
  assert.match(where, /screen_state = 'clear' AND screened_at <= \?::timestamptz - make_interval\(days => \?\)/);
  assert.doesNotMatch(where, /held|banned/);
  assert.match(text.split('ORDER BY')[1], /^ screen_state <> 'unscreened', screen_tried_at NULLS FIRST, CASE WHEN screen_state = 'unscreened' THEN first_found END, cluster_id LIMIT \?$/);
  assert.deepEqual(values, ['2026-11-25T23:00:00.000Z', 30, 2]);
});

test('a screen attempt records only its time; a clear or a hold writes the state, the times and (for a hold) the hold, and only over an unscreened or clear row', async () => {
  const world = fakeLibrary([clearRow(1, 'A', '2024-01-01', { screen_state: 'unscreened' }), clearRow(2, 'B', '2024-01-01', { screen_state: 'banned' })]);
  const at = '2026-11-25T23:00:13.000Z';
  await recordTried(world.sql, 1, at);
  assert.equal(flat(world.queries[0].text), 'UPDATE case_library SET screen_tried_at = ?::timestamptz WHERE cluster_id = ?');
  assert.deepEqual(world.queries[0].values, [at, 1]);

  assert.equal(await recordClear(world.sql, 1, at), true);
  const clear = world.queries[1];
  assert.equal(flat(clear.text), "UPDATE case_library SET screen_state = 'clear', screened_at = ?::timestamptz, screen_tried_at = ?::timestamptz WHERE cluster_id = ? AND screen_state IN ('unscreened', 'clear') RETURNING cluster_id");
  assert.doesNotMatch(clear.text, /hold|decided_at/, 'a clear never writes the hold, so the owner\'s record of a cleared hold survives');
  assert.deepEqual(clear.values, [at, at, 1]);
  assert.equal(await recordClear(world.sql, 2, at), false, 'a banned decision is not overwritten');

  const hold = { found_at: at, question: 'citing', later: { case_name: 'Later v. Case', url: null, court: null, date_filed: null }, passage: 'p' };
  assert.equal(await recordHeld(world.sql, 1, hold, at), true);
  const held = world.queries[3];
  assert.equal(flat(held.text), "UPDATE case_library SET screen_state = 'held', screened_at = ?::timestamptz, screen_tried_at = ?::timestamptz, hold = ?::jsonb WHERE cluster_id = ? AND screen_state IN ('unscreened', 'clear') RETURNING cluster_id");
  assert.deepEqual(held.values, [at, at, JSON.stringify(hold), 1]);
  assert.equal(await recordHeld(world.sql, 2, hold, at), false);
});

test('the held list asks for held rows only, newest hold first, and gives each decision its case types sorted', async () => {
  const hold = { found_at: '2026-11-25T23:00:13.000Z', question: 'citing', later: null, passage: null };
  const world = fakeLibrary([
    clearRow(1, 'A', '2024-01-01', { screen_state: 'held', hold, case_types: ['slip', 'auto'], pinned: true }),
    clearRow(2, 'B', '2024-01-01', { screen_state: 'clear' }),
    clearRow(3, 'C', '2024-01-01', { screen_state: 'held', hold, case_types: [] }),
  ]);
  const held = await heldDecisions(world.sql);
  const text = flat(world.queries[0].text);
  assert.match(text, /WHERE screen_state = 'held' ORDER BY hold->>'found_at' DESC NULLS LAST, cluster_id$/);
  assert.doesNotMatch(text, /pinned = FALSE/, 'a held pinned decision is listed');
  assert.deepEqual(held.map(row => row.cluster_id), [1, 3]);
  assert.deepEqual(Object.keys(held[0]).sort(), ['case_name', 'case_types', 'citations', 'cluster_id', 'court', 'date_filed', 'hold', 'pinned', 'url']);
  assert.deepEqual(held[0].case_types, ['auto', 'slip']);
  assert.deepEqual(held[1].case_types, []);
  assert.equal(held[0].pinned, true);
});

test('a banned or held decision is never picked for a reply', async () => {
  const world = fakeLibrary([clearRow(1, 'Banned v. Auto collision', '2025-01-01', { screen_state: 'banned' }), clearRow(2, 'Held v. Auto collision', '2025-01-01', { screen_state: 'held' }), clearRow(3, 'Clear v. Auto collision', '2020-01-01')]);
  assert.deepEqual((await pickDecisions(world.sql, { caseType: 'auto', terms: 'collision' })).map(d => d.clusterId), [3]);
  assert.match(flat(world.queries[0].text), /WHERE screen_state = 'clear' AND pinned = FALSE/);
});

test('the owner clears or bans a held decision, writing only over a held row; any other decision throws before a query', async () => {
  const world = fakeLibrary([clearRow(1, 'A', '2024-01-01', { screen_state: 'held' }), clearRow(2, 'B', '2024-01-01', { screen_state: 'held' }), clearRow(3, 'C', '2024-01-01', { screen_state: 'clear' })]);
  const at = '2026-11-26T14:00:00.000Z';
  assert.equal(await decideHeld(world.sql, 1, 'clear', at), true);
  const clear = world.queries[0];
  const unanswered = "COALESCE(hold->>'question', 'unreadable') = 'unreadable'";
  assert.equal(flat(clear.text), `UPDATE case_library SET screen_state = CASE WHEN ${unanswered} THEN 'unscreened' ELSE 'clear' END, `
    + `screened_at = CASE WHEN ${unanswered} THEN NULL ELSE ?::timestamptz END, decided_at = CASE WHEN ${unanswered} THEN NULL ELSE ?::timestamptz END `
    + "WHERE cluster_id = ? AND screen_state = 'held' RETURNING cluster_id");
  assert.doesNotMatch(clear.text, /screen_tried_at/, 'a clear keeps the try time');
  assert.deepEqual(clear.values, [at, at, 1]);
  assert.equal(await decideHeld(world.sql, 2, 'banned', at), true);
  const ban = world.queries[1];
  assert.equal(flat(ban.text), "UPDATE case_library SET screen_state = 'banned', decided_at = ?::timestamptz WHERE cluster_id = ? AND screen_state = 'held' RETURNING cluster_id");
  assert.deepEqual(ban.values, [at, 2]);
  assert.doesNotMatch(`${clear.text}${ban.text}`, /hold =/, 'the hold stays as the record of what the owner saw');
  assert.equal(await decideHeld(world.sql, 3, 'banned', at), false, 'a decision that is not held is not written');
  const before = world.queries.length;
  await assert.rejects(() => decideHeld(world.sql, 1, 'hold', at), /clear|banned/);
  await assert.rejects(() => decideHeld(world.sql, 1, undefined, at));
  assert.equal(world.queries.length, before, 'a query was sent for an unknown decision');
});

test('clearing a hold the screen could not read, or one that names no question, sends the decision back to be screened with its try time and its hold; any other hold clears', async () => {
  const tried = '2026-11-24T23:00:13.000Z';
  const unreadable = { found_at: tried, question: 'unreadable', status: 0, later: null, passage: null, seen: [] };
  const citing = { found_at: tried, question: 'citing', later: null, passage: 'p', seen: [77] };
  const held = (id, hold) => clearRow(id, `Held ${id}`, '2024-01-01', { screen_state: 'held', hold, screened_at: tried, screen_tried_at: tried, decided_at: null });
  const world = fakeLibrary([held(1, unreadable), held(2, null), held(3, { found_at: tried }), held(4, citing), held(5, { ...citing, question: 'higher-court' })]);
  const at = '2026-11-26T14:00:00.000Z';
  for (const id of [1, 2, 3, 4, 5]) assert.equal(await decideHeld(world.sql, id, 'clear', at), true, String(id));
  const row = id => world.rows.find(r => Number(r.cluster_id) === id);
  for (const id of [1, 2, 3]) {
    assert.deepEqual([row(id).screen_state, row(id).screened_at, row(id).decided_at, row(id).screen_tried_at], ['unscreened', null, null, tried], String(id));
  }
  assert.deepEqual(row(1).hold, unreadable, 'the hold stays as the record');
  for (const id of [4, 5]) assert.deepEqual([row(id).screen_state, row(id).screened_at, row(id).decided_at, row(id).screen_tried_at], ['clear', at, at, tried], String(id));
  assert.ok(world.queries.every(query => query.values.length === 3 && query.values[0] === at && query.values[1] === at), 'one query each, the same for every hold');
});
