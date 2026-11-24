// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Reading the State Bar's list of opinions (opinion-list.js). The page is a fake here. Nothing reaches the network.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { parseOpinionList, unseenOpinions, readOpinionListing, NO_NEW_OPINIONS } from '../opinion-list.js';
import { sourceReader } from '../statute-text.js';

const page = `<a href="https://nysba.org/ethics-opinion-1309-termination-of-representation/">x</a>
<a href="https://nysba.org/ethics-opinion-1306-unadmitted-law-graduates/">x</a><a href="https://nysba.org/ethics-opinion-1306-unadmitted-law-graduates/">y</a>
<a href="https://nysba.org/ethics-opinion-1290-older/">z</a>`;
const source = { kind: 'listing', url: 'https://nysba.org/news-center/?show_category=ethics-opinions', watch_from: 1295, seen: [1306] };
const answering = (status, body) => async () => ({ status, text: async () => body });

test('the list is read as one entry per opinion, newest first', () => {
  assert.deepEqual(parseOpinionList(page).map(o => o.number), [1309, 1306, 1290]);
  assert.equal(parseOpinionList(page)[1].title, 'unadmitted law graduates');
});
test('only opinions after the starting number that were not seen are new', async () => {
  const read = await readOpinionListing(source, { fetchImpl: answering(200, page) });
  assert.deepEqual(read.opinions.map(o => o.number), [1309]);
  assert.match(read.text, /^1309 termination of representation https:/);
});
test('a list with nothing new reads as no new opinions', async () => {
  const read = await readOpinionListing({ ...source, seen: [1306, 1309] }, { fetchImpl: answering(200, page) });
  assert.equal(read.text, NO_NEW_OPINIONS);
});
test('a refused, empty or failed page is unread and never quotes the address', async () => {
  assert.deepEqual(await readOpinionListing(source, { fetchImpl: answering(403, '') }), { ok: false, reason: 'status 403' });
  assert.deepEqual(await readOpinionListing(source, { fetchImpl: answering(200, '<html>new design</html>') }), { ok: false, reason: 'the page listed no opinions' });
  const failed = await readOpinionListing(source, { fetchImpl: async () => { throw new Error(`failed ${source.url}`); } });
  assert.deepEqual(failed, { ok: false, reason: 'the request failed' });
});
test('the reader serves a listing without a Senate key', async () => {
  const read = await sourceReader(undefined, { fetchImpl: answering(200, page) })(source);
  assert.equal(read.ok, true);
});
test('a page that never answers is reported as timed out', async () => {
  const never = (url, { signal }) => new Promise(() => {});
  assert.deepEqual(await readOpinionListing(source, { fetchImpl: never, timeoutMs: 20 }), { ok: false, reason: 'the request timed out' });
});
test('links with no slug, with www., or relative are read as new opinions', async () => {
  const mixed = `<a href="https://nysba.org/ethics-opinion-1309-termination-of-representation/">seen</a>
<a href="https://nysba.org/ethics-opinion-1310/">a</a>
<a href="https://www.nysba.org/ethics-opinion-1311-with-www/">b</a>
<a href='/ethics-opinion-1312-relative-link'>c</a>`;
  const read = await readOpinionListing({ ...source, seen: [1309] }, { fetchImpl: answering(200, mixed) });
  assert.deepEqual(read.opinions.map(o => o.number), [1312, 1311, 1310]);
  assert.deepEqual(read.opinions.map(o => o.url), [
    'https://nysba.org/ethics-opinion-1312-relative-link/',
    'https://nysba.org/ethics-opinion-1311-with-www/',
    'https://nysba.org/ethics-opinion-1310/',
  ]);
  assert.deepEqual(read.opinions.map(o => o.title), ['relative link', 'with www', 'Opinion 1310']);
});
test('a longer number is not read as a shorter one', () => {
  const list = parseOpinionList('<a href="https://nysba.org/ethics-opinion-13100-long/">x</a>');
  assert.deepEqual(list.map(o => o.number), [13100]);
});
test('a percent-encoded slug is kept whole', () => {
  const list = parseOpinionList('<a href="https://nysba.org/ethics-opinion-1310-caf%C3%A9-rules/">x</a>');
  assert.equal(list[0].url, 'https://nysba.org/ethics-opinion-1310-caf%C3%A9-rules/');
});
test('unseenOpinions leaves out earlier and seen numbers', () => {
  assert.deepEqual(unseenOpinions(source, parseOpinionList(page)).map(o => o.number), [1309]);
});
