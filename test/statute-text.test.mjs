// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The official text of a New York statute (statute-text.js): reading it from the Senate's Open Legislation API, tidying it,
// fingerprinting it and comparing two versions. The Senate is a fake here. Nothing reaches the network.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import {
  tidyStatuteText, statuteFingerprint, diffStatuteText, diffToHtml,
  fetchLawSection, fetchBillStatus, fetchLawIndex, fetchLawTree, sourceReader,
} from '../statute-text.js';

const KEY = 'nysenate-sentinel-key-123';

// A fake of fetch that answers once with a JSON body, and records the address it was asked for.
function answering(body, status = 200) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(new URL(String(url)));
    return { status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { fetchImpl, asked };
}

const SECTION = { success: true, result: { lawId: 'CVP', locationId: '214', title: 'Actions to be commenced within three years', text: 'S 214. Actions to be commenced\r\n  1. an action  ', activeDate: '2014-09-22', repealed: false } };

test('fetchLawSection asks for one section with the key as a query parameter', async () => {
  const { fetchImpl, asked } = answering(SECTION);
  const got = await fetchLawSection({ lawId: 'CVP', locationId: '214', key: KEY, fetchImpl });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].origin + asked[0].pathname, 'https://legislation.nysenate.gov/api/3/laws/CVP/214');
  assert.equal(asked[0].searchParams.get('key'), KEY);
  assert.deepEqual(got, { ok: true, text: tidyStatuteText(SECTION.result.text), title: 'Actions to be commenced within three years', activeDate: '2014-09-22', repealed: false, repealedDate: null });
});

test('an answer that cannot be read is a failure, never a text', async () => {
  const cases = [
    ['a 404', answering({ success: false, message: 'x', errorCode: 21 }, 404), /status 404/],
    ['a 500', answering('oops', 500), /status 500/],
    ['a body that is not JSON', answering('not json'), /not JSON/],
    ['success: false', answering({ success: false, message: 'x' }), /success: false/],
    ['no result', answering({ success: true, result: {} }), /no text/],
    ['empty text, not repealed', answering({ success: true, result: { text: '', repealed: false } }), /no text/],
  ];
  for (const [name, { fetchImpl }, reason] of cases) {
    const got = await fetchLawSection({ lawId: 'CVP', locationId: '214', key: KEY, fetchImpl });
    assert.equal(got.ok, false, name);
    assert.match(got.reason, reason, name);
  }
  // A fake that never settles, and never looks at the signal it was given, still ends with a reason.
  const hung = await fetchLawSection({ lawId: 'CVP', locationId: '214', key: KEY, fetchImpl: () => new Promise(() => {}), timeoutMs: 50 });
  assert.equal(hung.ok, false);
  assert.match(hung.reason, /timed out/);
  // So does one whose body never arrives.
  const slowBody = await fetchLawSection({ lawId: 'CVP', locationId: '214', key: KEY, timeoutMs: 50, fetchImpl: async () => ({ status: 200, text: () => new Promise(() => {}) }) });
  assert.equal(slowBody.ok, false);
  assert.match(slowBody.reason, /timed out/);
});

test('a repealed section is read, with its date', async () => {
  const { fetchImpl } = answering({ success: true, result: { lawId: 'CVP', locationId: '214', title: 'Gone', text: '', repealed: true, repealedDate: '2026-05-26', activeDate: '2020-01-01' } });
  const got = await fetchLawSection({ lawId: 'CVP', locationId: '214', key: KEY, fetchImpl });
  assert.equal(got.ok, true);
  assert.equal(got.repealed, true);
  assert.equal(got.repealedDate, '2026-05-26');
});

test('no key: no request, a plain reason', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return {}; };
  const got = await fetchLawSection({ lawId: 'CVP', locationId: '214', key: '', fetchImpl });
  assert.deepEqual(got, { ok: false, reason: 'NYSENATE_API_KEY is not set' });
  assert.equal(calls, 0);
});

test('a reason never carries the key or the address', async () => {
  const before = process.env.NYSENATE_API_KEY;
  process.env.NYSENATE_API_KEY = KEY;
  try {
    const fetchImpl = async () => { throw new Error(`connect failed for https://legislation.nysenate.gov/api/3/laws/CVP/214?key=${KEY}`); };
    const got = await fetchLawSection({ lawId: 'CVP', locationId: '214', key: KEY, fetchImpl });
    assert.equal(got.ok, false);
    assert.ok(!got.reason.includes(KEY));
    assert.ok(!got.reason.includes('key='));
    assert.ok(!got.reason.includes('legislation.nysenate.gov/api'));
  } finally {
    if (before === undefined) delete process.env.NYSENATE_API_KEY; else process.env.NYSENATE_API_KEY = before;
  }
});

test('a redirect is never followed, so the key stays with the Senate\'s host', async () => {
  let init;
  const seen = async (url, options) => {
    init = options;
    return { status: 200, ok: true, text: async () => JSON.stringify(SECTION) };
  };
  await fetchLawSection({ lawId: 'CVP', locationId: '214', key: KEY, fetchImpl: seen });
  assert.equal(init.redirect, 'error');
  // fetch rejects a redirect it was told not to follow; that is an unread section with the fixed reason, never a change.
  const redirected = async () => { throw new TypeError('fetch failed: unexpected redirect'); };
  const got = await fetchLawSection({ lawId: 'CVP', locationId: '214', key: KEY, fetchImpl: redirected });
  assert.deepEqual(got, { ok: false, reason: 'the request failed' });
});

test('fetchBillStatus reads the status of one bill', async () => {
  const { fetchImpl, asked } = answering({ success: true, result: { printNo: 'S1234', status: { statusType: 'VETOED', statusDesc: 'Vetoed', actionDate: '2025-12-05' }, signed: false } });
  const got = await fetchBillStatus({ session: 2025, printNo: 'S1234', key: KEY, fetchImpl });
  assert.equal(asked[0].pathname, '/api/3/bills/2025/S1234');
  assert.equal(asked[0].searchParams.get('view'), 'info');
  assert.equal(asked[0].searchParams.get('key'), KEY);
  assert.equal(got.ok, true);
  assert.equal(got.activeDate, '2025-12-05');
  assert.equal(got.text, 'Vetoed (VETOED) on 2025-12-05\nsigned: no');
  const unread = await fetchBillStatus({ session: 2025, printNo: 'S1234', key: KEY, fetchImpl: answering({ success: true, result: { signed: true } }).fetchImpl });
  assert.equal(unread.ok, false);
});

test('fetchLawIndex lists every law in one page, and fetchLawTree flattens a law depth first', async () => {
  const index = answering({ success: true, result: { items: [{ lawId: 'CVP', name: 'Civil Practice Law & Rules', lawType: 'CONSOLIDATED', chapter: '8' }, { lawId: 'EPT', name: 'Estates, Powers & Trusts', lawType: 'CONSOLIDATED', chapter: '17B' }], size: 2 } });
  const laws = await fetchLawIndex({ key: KEY, fetchImpl: index.fetchImpl });
  assert.equal(index.asked[0].pathname, '/api/3/laws');
  assert.equal(index.asked[0].searchParams.get('limit'), '1000');
  assert.deepEqual(laws.laws.map(law => law.lawId), ['CVP', 'EPT']);

  const leaf = (locationId, title) => ({ lawId: 'CVP', locationId, title, docType: 'SECTION', documents: { items: [], size: 0 } });
  const tree = answering({ success: true, result: { lawId: 'CVP', documents: { lawId: 'CVP', locationId: '', title: 'Civil Practice', docType: 'CHAPTER', documents: { size: 2, items: [
    { lawId: 'CVP', locationId: 'A2', title: 'Article 2', docType: 'ARTICLE', documents: { size: 2, items: [leaf('213', 'Actions to be commenced within six years'), leaf('214', 'Three years')] } },
    { lawId: 'CVP', locationId: 'A3', title: 'Article 3', docType: 'ARTICLE', documents: { size: 0, items: [] } },
  ] } } } });
  const got = await fetchLawTree({ lawId: 'CVP', key: KEY, fetchImpl: tree.fetchImpl });
  assert.equal(tree.asked[0].pathname, '/api/3/laws/CVP');
  assert.deepEqual(got.documents.map(document => document.locationId), ['', 'A2', '213', '214', 'A3']);
  assert.deepEqual(got.documents[3], { locationId: '214', docType: 'SECTION', title: 'Three years' });
});

test('sourceReader reads a section or a bill with the key it was given', async () => {
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(new URL(String(url)));
    const body = String(url).includes('/bills/') ? { success: true, result: { status: { statusType: 'SIGNED', statusDesc: 'Signed', actionDate: '2026-01-02' }, signed: true } } : SECTION;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    const read = sourceReader(KEY);
    const section = await read({ kind: 'section', lawId: 'CVP', locationId: '214' });
    const bill = await read({ kind: 'bill', session: 2025, printNo: 'S1234' });
    assert.equal(section.ok, true);
    assert.equal(bill.text, 'Signed (SIGNED) on 2026-01-02\nsigned: yes');
    assert.deepEqual(asked.map(url => url.pathname), ['/api/3/laws/CVP/214', '/api/3/laws/CVP', '/api/3/bills/2025/S1234']); // the fake's answer to the tree has no tree, which is no change
    assert.ok(asked.every(url => url.searchParams.get('key') === KEY));
  } finally {
    globalThis.fetch = real;
  }
});

// A fake Senate for sourceReader: sections answer SECTION-shaped bodies, a law's tree lists `inTree` sections, and every request
// is kept. `tree` can be replaced by a function of the address, to answer a failure.
function senateOf({ inTree = ['213', '214'], tree } = {}) {
  const asked = [];
  const fetchImpl = async (url) => {
    const address = new URL(String(url));
    asked.push(address);
    const parts = address.pathname.split('/').filter(Boolean);
    if (parts[2] === 'bills') return { status: 200, text: async () => JSON.stringify({ success: true, result: { status: { statusType: 'SIGNED', statusDesc: 'Signed', actionDate: '2026-01-02' }, signed: true } }) };
    if (parts.length === 5) {
      return { status: 200, text: async () => JSON.stringify({ success: true, result: { ...SECTION.result, locationId: parts[4] } }) };
    }
    if (tree) return tree(address);
    const leaves = inTree.map(locationId => ({ lawId: parts[3], locationId, title: 't', docType: 'SECTION', documents: { items: [], size: 0 } }));
    return { status: 200, text: async () => JSON.stringify({ success: true, result: { lawId: parts[3], documents: { locationId: '', title: 'Law', docType: 'CHAPTER', documents: { size: leaves.length, items: leaves } } } }) };
  };
  return { fetchImpl, asked, treeRequests: () => asked.filter(url => url.pathname.split('/').filter(Boolean).length === 4) };
}

const SECTION_214 = { kind: 'section', lawId: 'CVP', locationId: '214' };

test('a section in its law\'s current tree is read as it is', async () => {
  const { fetchImpl, treeRequests } = senateOf();
  const got = await sourceReader(KEY, { fetchImpl })(SECTION_214);
  assert.equal(got.ok, true);
  assert.equal(got.repealed, false);
  assert.equal(got.gone, undefined);
  assert.equal(treeRequests().length, 1);
});

test('a section missing from its law\'s current tree is read as repealed, with its text kept', async () => {
  const { fetchImpl } = senateOf({ inTree: ['213'] });
  const got = await sourceReader(KEY, { fetchImpl })(SECTION_214);
  assert.equal(got.ok, true);
  assert.equal(got.repealed, true);
  assert.equal(got.repealedDate, null);
  assert.equal(got.gone, true);
  assert.equal(got.text, tidyStatuteText(SECTION.result.text));
  assert.equal(got.activeDate, '2014-09-22');
  assert.notEqual(statuteFingerprint(got), statuteFingerprint({ text: got.text }));
});

test('a tree that cannot be read leaves the section as it was read', async () => {
  const cases = [
    ['success: false', () => ({ status: 200, text: async () => JSON.stringify({ success: false, message: 'x' }) })],
    ['a 500', () => ({ status: 500, text: async () => 'oops' })],
    ['a throw', () => { throw new Error(`connect failed for https://legislation.nysenate.gov/api/3/laws/CVP?key=${KEY}`); }],
    ['no documents', () => ({ status: 200, text: async () => JSON.stringify({ success: true, result: {} }) })],
  ];
  for (const [name, tree] of cases) {
    const { fetchImpl, treeRequests } = senateOf({ tree });
    const got = await sourceReader(KEY, { fetchImpl })(SECTION_214);
    assert.equal(treeRequests().length, 1, name);
    assert.equal(got.ok, true, name);
    assert.equal(got.repealed, false, name);
    assert.equal(got.gone, undefined, name);
    assert.equal(got.text, tidyStatuteText(SECTION.result.text), name);
  }
});

test('two sections of one law in one reader read the law\'s tree once, and another law has its own', async () => {
  const { fetchImpl, treeRequests } = senateOf({ inTree: ['213', '214'] });
  const read = sourceReader(KEY, { fetchImpl });
  const [a, b] = await Promise.all([read(SECTION_214), read({ kind: 'section', lawId: 'CVP', locationId: '213' })]);
  const c = await read({ kind: 'section', lawId: 'CVP', locationId: '214' });
  assert.deepEqual([a.repealed, b.repealed, c.repealed], [false, false, false]);
  assert.equal(treeRequests().length, 1);
  await read({ kind: 'section', lawId: 'EPT', locationId: '214' });
  assert.deepEqual(treeRequests().map(url => url.pathname), ['/api/3/laws/CVP', '/api/3/laws/EPT']);
  // A new reader reads the tree again.
  await sourceReader(KEY, { fetchImpl })(SECTION_214);
  assert.equal(treeRequests().length, 3);
});

test('a bill read asks no tree', async () => {
  const { fetchImpl, asked } = senateOf();
  const got = await sourceReader(KEY, { fetchImpl })({ kind: 'bill', session: 2025, printNo: 'S1234' });
  assert.equal(got.ok, true);
  assert.deepEqual(asked.map(url => url.pathname), ['/api/3/bills/2025/S1234']);
});

test('the tree is asked with the key only as the key parameter, and no reason carries it', async () => {
  const { fetchImpl, asked } = senateOf({ inTree: ['213'] });
  const got = await sourceReader(KEY, { fetchImpl })(SECTION_214);
  assert.equal(got.gone, true);
  const tree = asked.find(url => url.pathname === '/api/3/laws/CVP');
  assert.equal(tree.searchParams.get('key'), KEY);
  assert.deepEqual([...tree.searchParams.keys()], ['key']);
  assert.ok(!tree.pathname.includes(KEY));
  assert.ok(!JSON.stringify(got).includes(KEY));
  const failing = senateOf({ tree: () => { throw new Error(`failed https://legislation.nysenate.gov/api/3/laws/CVP?key=${KEY}`); } });
  const failed = await fetchLawTree({ lawId: 'CVP', key: KEY, fetchImpl: failing.fetchImpl });
  assert.equal(failed.ok, false);
  assert.ok(!failed.reason.includes(KEY) && !failed.reason.includes('key='));
});

test('the tree read ends with the signal of the read that wanted it', async () => {
  const controller = new AbortController();
  const fetchImpl = async (url, options) => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean);
    if (parts.length === 5) return { status: 200, text: async () => JSON.stringify(SECTION) };
    controller.abort();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  const got = await sourceReader(KEY, { fetchImpl })(SECTION_214, { signal: controller.signal });
  assert.equal(got.ok, true);
  assert.equal(got.repealed, false, 'a tree that did not answer is not a change');
});

test('tidyStatuteText turns the Senate\'s backslash-n into a line break', () => {
  assert.equal(
    tidyStatuteText('  § 5-4.1 Action by personal representative for wrongful act, neglect or\\n          default causing death of decedent\\n  1. The personal representative'),
    '§ 5-4.1 Action by personal representative for wrongful act, neglect or\ndefault causing death of decedent\n1. The personal representative',
  );
  assert.equal(tidyStatuteText('a\\n\\nb\nc'), 'a\nb\nc');
});

test('a backslash-n and a real line break give one fingerprint, the same as a space', () => {
  const pairs = statuteFingerprint({ text: 'for non-payment of\\nmoney collected' });
  assert.equal(pairs, statuteFingerprint({ text: 'for non-payment of\nmoney collected' }));
  assert.equal(pairs, statuteFingerprint({ text: 'for non-payment of money collected' }));
});

test('fetchLawSection gives the live shape, a backslash-n in the JSON, as real line breaks', async () => {
  const body = JSON.stringify({ success: true, result: { lawId: 'CVP', locationId: '214', title: 'Actions to be commenced within three years', activeDate: '2022-02-25', text: '  § 214. Actions to be commenced within three years: for non-payment of\\nmoney collected on execution' } });
  const got = await fetchLawSection({ lawId: 'CVP', locationId: '214', key: KEY, fetchImpl: answering(body).fetchImpl });
  assert.equal(got.ok, true);
  assert.equal(got.text, '§ 214. Actions to be commenced within three years: for non-payment of\nmoney collected on execution');
  assert.ok(!got.text.includes('\\'));
});

test('spacing alone changes no fingerprint', () => {
  const plain = 'An action to recover damages for a personal injury must be commenced within three years.';
  const wrapped = 'An action to recover\r\n damages for a  personal\tinjury must be\r\ncommenced within three years.  ';
  assert.equal(statuteFingerprint({ text: plain }), statuteFingerprint({ text: wrapped }));
  assert.notEqual(statuteFingerprint({ text: plain }), statuteFingerprint({ text: plain.replace('three', 'two') }));
  assert.notEqual(statuteFingerprint({ text: plain }), statuteFingerprint({ text: plain, repealed: true, repealedDate: '2026-05-26' }));
  assert.match(statuteFingerprint({ text: plain }), /^sha256:[0-9a-f]{64}$/);
  // A read result goes in whole, whatever else it carries.
  const read = { ok: true, text: plain, title: 'x', activeDate: '2014-09-22', repealed: true, repealedDate: '2026-05-26' };
  assert.equal(statuteFingerprint(read), statuteFingerprint({ text: plain, repealed: true, repealedDate: '2026-05-26' }));
});

test('tidyStatuteText trims every line, drops blank ones and joins with \\n', () => {
  assert.equal(tidyStatuteText('  S 214. Actions\r\n\r\n\t1.  an   action here \r  \n 2. done  '), 'S 214. Actions\n1. an action here\n2. done');
  // Two spellings of one letter are one text.
  assert.equal(tidyStatuteText('é'), 'é');
});

test('diffStatuteText marks the changed words and folds long unchanged runs', () => {
  const words = Array.from({ length: 300 }, (_, i) => `w${i}`);
  const changed = words.slice();
  words[150] = 'old';
  changed[150] = 'new';
  const parts = diffStatuteText(words.join(' '), changed.join(' '), { context: 25 });
  assert.deepEqual(parts.map(part => part.kind), ['gap', 'same', 'removed', 'added', 'same', 'gap']);
  assert.equal(parts.find(part => part.kind === 'removed').text, 'old');
  assert.equal(parts.find(part => part.kind === 'added').text, 'new');
  assert.equal(parts[1].text.split(' ').length, 25);

  const same = diffStatuteText('one two three', 'one  two\nthree');
  assert.ok(!same.some(part => part.kind === 'removed' || part.kind === 'added'));

  const nothing = diffStatuteText('alpha beta', 'gamma delta');
  assert.deepEqual(nothing.map(part => part.kind), ['removed', 'added']);

  const big = n => Array.from({ length: n }, (_, i) => `x${i}`).join(' ');
  const huge = diffStatuteText(`head ${big(2500)} tail`, `head ${big(2500).replaceAll('x', 'y')} tail`, { context: 2 });
  assert.deepEqual(huge.map(part => part.kind), ['same', 'removed', 'added', 'same']);
  assert.equal(huge[1].text.split(' ').length, 2500);
  assert.equal(huge[2].text.split(' ').length, 2500);
});

test('diffToHtml escapes text and marks removals and additions', () => {
  const html = diffToHtml(diffStatuteText('keep <b>& old', 'keep <b>& new'));
  assert.match(html, /<del>old<\/del>/);
  assert.match(html, /<ins>new<\/ins>/);
  assert.ok(html.includes('&lt;b&gt;&amp;'));
  assert.ok(!html.includes('<b>'));
});

test('a tree with no sections in it is unreadable, never a sign that a section was repealed', async () => {
  const root = { lawId: 'CVP', locationId: '', docType: 'CHAPTER', title: 'x' };
  const answers = {
    'no documents.items': root,
    'empty documents.items': { ...root, documents: { items: [], size: 0 } },
    'only articles': { ...root, documents: { items: [{ lawId: 'CVP', locationId: 'A2', docType: 'ARTICLE', title: 'a', documents: { items: [], size: 0 } }], size: 1 } },
  };
  for (const [name, documents] of Object.entries(answers)) {
    const tree = () => ({ status: 200, text: async () => JSON.stringify({ success: true, result: { lawId: 'CVP', documents } }) });
    const { fetchImpl } = senateOf({ tree });
    const got = await sourceReader(KEY, { fetchImpl })(SECTION_214);
    assert.equal(got.ok, true, name);
    assert.equal(got.repealed, false, name);
    assert.equal(got.gone, undefined, name);
  }
  // A tree with sections, but not this one, still says it is gone.
  const { fetchImpl } = senateOf({ inTree: ['213'] });
  assert.equal((await sourceReader(KEY, { fetchImpl })(SECTION_214)).gone, true);
});
