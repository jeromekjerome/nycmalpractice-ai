// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// statute-text.js — the official text of a New York statute: read from the Senate's Open Legislation API, tidied, fingerprinted
// and compared. The same file in every app. The statute watch (law.mjs and the nightly job) is built on these functions.
//
// It imports only node:crypto and without-keys.js, because law.mjs imports it, and law.mjs must not reach db.js (which loads
// the local .env, with its live keys, as soon as it is imported).
//
// Every read answers { ok: true, ... } or { ok: false, reason }. A failure is never a text: an answer that cannot be read is
// reported as unread, so that nothing mistakes "the Senate did not answer" for "the statute is now empty". A reason is one of
// a few fixed phrases. It never quotes the address (which carries the key) or the text of a thrown error, and it passes
// through withoutKeys all the same.
import { createHash } from 'node:crypto';
import { withoutKeys } from './without-keys.js';

export const SENATE_API = 'https://legislation.nysenate.gov/api/3';
const DEFAULT_TIMEOUT_MS = 8000;
// The laws' index allows a page of 1,000 laws at most, and there are about 134.
const INDEX_LIMIT = 1000;
// A longest-common-subsequence table is the square of the words. Past this many words on either side the changed middle is
// reported whole, as removed and then added, rather than worked out word by word.
const MOST_WORDS_TO_COMPARE = 2000;

function failure(reason) {
  return { ok: false, reason: withoutKeys(reason) };
}

// One request, answered with the `result` of the Senate's wrapper { success, message, responseType, result }.
async function ask(path, params, { key, fetchImpl, signal, timeoutMs } = {}) {
  if (!key) return failure('NYSENATE_API_KEY is not set');
  const send = fetchImpl ?? globalThis.fetch;
  const url = new URL(`${SENATE_API}${path}`);
  for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, String(value));
  url.searchParams.set('key', key);

  // The request, and the reading of its body, are raced against the abort, so that a fetch that ignores the signal still ends.
  // The timer is the ordinary kind, which keeps the process alive until it fires.
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([timer.signal, signal]) : timer.signal;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('aborted'));
    if (combined.aborted) onAbort(); else combined.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  let response;
  let raw;
  try {
    response = await Promise.race([send(url, { signal: combined, redirect: 'error' }), aborted]);
    if (response?.status !== 200) return failure(`status ${response?.status}`);
    raw = await Promise.race([typeof response.text === 'function' ? response.text() : response.json().then(JSON.stringify), aborted]);
  } catch {
    return failure(timer.signal.aborted ? 'the request timed out' : 'the request failed');
  } finally {
    clearTimeout(timeout);
    combined.removeEventListener('abort', onAbort);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return failure('the answer was not JSON');
  }
  if (!body || typeof body !== 'object' || body.success !== true) return failure('the answer said success: false');
  return { ok: true, result: body.result };
}

export function tidyStatuteText(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/\\n/g, '\n') // the Senate's API writes a line break as a backslash and an n
    .replace(/\r\n?/g, '\n')
    .replace(/[   \t]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

// Re-wrapping or re-spacing the same words changes nothing here. A repealed section counts as another text, even though the
// Senate gives a repealed section no text of its own.
export function statuteFingerprint({ text, repealed = false, repealedDate = null } = {}) {
  const words = tidyStatuteText(text).replace(/\s+/g, ' ').trim();
  const sealed = words + (repealed ? `\n[repealed ${repealedDate ?? ''}]` : '');
  return `sha256:${createHash('sha256').update(sealed).digest('hex')}`;
}

export async function fetchLawSection({ lawId, locationId, key, fetchImpl, signal, timeoutMs } = {}) {
  const answer = await ask(`/laws/${encodeURIComponent(lawId)}/${encodeURIComponent(locationId)}`, {}, { key, fetchImpl, signal, timeoutMs });
  if (!answer.ok) return answer;
  const found = answer.result;
  if (!found || typeof found !== 'object') return failure('the answer had no text');
  // The Senate's example of a single section has no `repealed`, so only an explicit true counts.
  const repealed = found.repealed === true;
  const text = tidyStatuteText(typeof found.text === 'string' ? found.text : '');
  if (!text && !repealed) return failure('the answer had no text');
  return { ok: true, text, title: found.title ?? '', activeDate: found.activeDate ?? null, repealed, repealedDate: found.repealedDate ?? null };
}

// A bill's standing is the whole of its "text": what the last action was, and whether it was signed.
export async function fetchBillStatus({ session, printNo, key, fetchImpl, signal, timeoutMs } = {}) {
  const answer = await ask(`/bills/${encodeURIComponent(session)}/${encodeURIComponent(printNo)}`, { view: 'info' }, { key, fetchImpl, signal, timeoutMs });
  if (!answer.ok) return answer;
  const status = answer.result?.status;
  if (!status || typeof status.statusType !== 'string' || typeof status.statusDesc !== 'string' || typeof status.actionDate !== 'string') return failure('the answer had no text');
  const text = `${status.statusDesc} (${status.statusType}) on ${status.actionDate}\nsigned: ${answer.result.signed === true ? 'yes' : 'no'}`;
  return { ok: true, text, title: answer.result.title ?? '', activeDate: status.actionDate, repealed: false, repealedDate: null };
}

export async function fetchLawIndex({ key, fetchImpl, signal, timeoutMs } = {}) {
  const answer = await ask('/laws', { limit: INDEX_LIMIT }, { key, fetchImpl, signal, timeoutMs });
  if (!answer.ok) return answer;
  if (!Array.isArray(answer.result?.items)) return failure('the answer had no text');
  return { ok: true, laws: answer.result.items.map(({ lawId, name, lawType, chapter }) => ({ lawId, name, lawType, chapter })) };
}

// A law's tree is one node, the law itself, with its children under documents.items, and theirs under theirs. It is flattened
// depth first, the root included.
export async function fetchLawTree({ lawId, key, fetchImpl, signal, timeoutMs } = {}) {
  const answer = await ask(`/laws/${encodeURIComponent(lawId)}`, {}, { key, fetchImpl, signal, timeoutMs });
  if (!answer.ok) return answer;
  const root = answer.result?.documents;
  if (!root || typeof root !== 'object') return failure('the answer had no text');
  const documents = [];
  const walk = node => {
    documents.push({ locationId: node.locationId ?? '', docType: node.docType ?? '', title: node.title ?? '' });
    if (Array.isArray(node.documents?.items)) for (const child of node.documents.items) walk(child);
  };
  walk(root);
  return { ok: true, documents };
}

// A law's tree is far larger than one section.
const TREE_TIMEOUT_MS = 15000;

// One reader for either kind of source, for the command line and the nightly job alike. `fetchImpl` is for tests.
//
// The Senate keeps serving a section that is no longer part of its law, with its old text and no `repealed` key, so a read of
// the section alone cannot tell. A section whose locationId is missing from its law's current tree is read as repealed
// (`repealed: true`, no date, `gone: true`). The tree is read once per law for this reader; the promise is kept, so sections
// of one law read at once share one request. A tree that cannot be read is never a change: the section is returned as read.
export function sourceReader(key, { fetchImpl } = {}) {
  const trees = new Map();
  const treeOf = (lawId, signal) => {
    const name = String(lawId);
    if (!trees.has(name)) {
      trees.set(name, Promise.resolve()
        .then(() => fetchLawTree({ lawId, key, fetchImpl, signal, timeoutMs: TREE_TIMEOUT_MS }))
        .catch(() => ({ ok: false })));
    }
    return trees.get(name);
  };
  return async function readSource(source, { signal } = {}) {
    if (source.kind === 'bill') return fetchBillStatus({ session: source.session, printNo: source.printNo, key, fetchImpl, signal });
    const read = await fetchLawSection({ lawId: source.lawId, locationId: source.locationId, key, fetchImpl, signal });
    if (!read.ok || read.repealed) return read;
    // A tree with no section in it is a partial answer, not a law with nothing left: it is unreadable, never a repeal.
    const tree = await treeOf(source.lawId, signal);
    if (tree?.ok === true && Array.isArray(tree.documents) && tree.documents.some(document => document.docType === 'SECTION') && !tree.documents.some(document => document.locationId === source.locationId)) {
      return { ...read, repealed: true, repealedDate: null, gone: true };
    }
    return read;
  };
}

function words(text) {
  return tidyStatuteText(text).split(/\s+/).filter(Boolean);
}

// The words of two texts, as a list of runs { kind: 'same' | 'removed' | 'added', words }.
function wordRuns(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  const middleA = a.slice(start, a.length - end);
  const middleB = b.slice(start, b.length - end);

  const runs = [];
  const push = (kind, list) => { if (list.length) runs.push({ kind, words: list }); };
  push('same', a.slice(0, start));
  if (middleA.length > MOST_WORDS_TO_COMPARE || middleB.length > MOST_WORDS_TO_COMPARE) {
    push('removed', middleA);
    push('added', middleB);
  } else {
    // lengths[i][j] is how many words the tails middleA[i..] and middleB[j..] have in common.
    const width = middleB.length + 1;
    const lengths = new Uint16Array((middleA.length + 1) * width);
    for (let i = middleA.length - 1; i >= 0; i -= 1) {
      for (let j = middleB.length - 1; j >= 0; j -= 1) {
        lengths[i * width + j] = middleA[i] === middleB[j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let removed = [];
    let added = [];
    const flush = () => { push('removed', removed); push('added', added); removed = []; added = []; };
    let i = 0;
    let j = 0;
    while (i < middleA.length || j < middleB.length) {
      if (i < middleA.length && j < middleB.length && middleA[i] === middleB[j]) {
        flush();
        const last = runs[runs.length - 1];
        if (last?.kind === 'same') last.words.push(middleA[i]); else runs.push({ kind: 'same', words: [middleA[i]] });
        i += 1; j += 1;
      } else if (j >= middleB.length || (i < middleA.length && lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        removed.push(middleA[i]); i += 1;
      } else {
        added.push(middleB[j]); j += 1;
      }
    }
    flush();
  }
  push('same', a.slice(a.length - end));
  // The prefix and the suffix are runs of their own; they join the middle's neighbours when the middle starts or ends with 'same'.
  return runs.reduce((merged, run) => {
    const last = merged[merged.length - 1];
    if (last?.kind === run.kind) last.words = last.words.concat(run.words); else merged.push({ kind: run.kind, words: run.words.slice() });
    return merged;
  }, []);
}

// What changed between two texts, as parts { kind, text } in reading order. An unchanged run longer than the context keeps
// `context` words next to a change and folds the rest into a { kind: 'gap', text: '', words } part.
export function diffStatuteText(oldText, newText, { context = 25 } = {}) {
  const runs = wordRuns(words(oldText), words(newText));
  const parts = [];
  const keep = list => { if (list.length) parts.push({ kind: 'same', text: list.join(' ') }); };
  runs.forEach((run, index) => {
    if (run.kind !== 'same') { parts.push({ kind: run.kind, text: run.words.join(' ') }); return; }
    const list = run.words;
    const before = index > 0;
    const after = index < runs.length - 1;
    // A run at the start keeps only its end, next to the change; one at the end keeps only its start; one between two changes
    // (or one that is the whole text) keeps both.
    const keepStart = before || !after;
    const keepEnd = after || !before;
    const kept = (keepStart ? context : 0) + (keepEnd ? context : 0);
    if (list.length <= kept) { keep(list); return; }
    if (keepStart) keep(list.slice(0, context));
    parts.push({ kind: 'gap', text: '', words: list.length - kept });
    if (keepEnd) keep(context ? list.slice(-context) : []);
  });
  return parts;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function diffToHtml(parts) {
  return parts.map(part => {
    if (part.kind === 'removed') return `<del>${escapeHtml(part.text)}</del>`;
    if (part.kind === 'added') return `<ins>${escapeHtml(part.text)}</ins>`;
    if (part.kind === 'gap') return `<span>[${part.words} unchanged words]</span>`;
    return escapeHtml(part.text);
  }).join(' ');
}
