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
test('unseenOpinions leaves out earlier and seen numbers', () => {
  assert.deepEqual(unseenOpinions(source, parseOpinionList(page)).map(o => o.number), [1309]);
});
