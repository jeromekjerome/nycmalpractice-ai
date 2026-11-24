// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// opinion-list.js — the State Bar's public list of its newest opinions, read as a source for the statute watch. The same file in
// every app.
//
// It imports only without-keys.js, because statute-text.js imports it, and law.mjs imports that; none of them may reach db.js
// (which loads the local .env, with its live keys, as soon as it is imported).
//
// A read answers { ok: true, ... } or { ok: false, reason }. A reason is one of a few fixed phrases. It never quotes the
// address or the text of a thrown error, and it passes through withoutKeys all the same.
import { withoutKeys } from './without-keys.js';

export const NO_NEW_OPINIONS = 'No new opinions.';
const DEFAULT_TIMEOUT_MS = 8000;
// An address on nysba.org (with or without www.) or a root-relative one, to ethics-opinion-<number> and an optional -<slug>,
// ended by a slash, a quote, a ?, a # or white space. The number is the whole run of digits.
const OPINION_LINK = /(?<=["'(=\s]|^)(?:https:\/\/(?:www\.)?nysba\.org)?\/ethics-opinion-(\d+)(?:-([a-z0-9%-]+?))?(?=[\/"'?#\s]|$)/gi;

function titleOf(slug, number) {
  if (!slug) return `Opinion ${number}`;
  let words = slug;
  try { words = decodeURIComponent(slug); } catch { /* a bad escape stays as written */ }
  return words.toLowerCase().replace(/-+/g, ' ').trim() || `Opinion ${number}`;
}

function failure(reason) {
  return { ok: false, reason: withoutKeys(reason) };
}

// One entry per opinion number, newest first. The title is the address's words after the number.
export function parseOpinionList(html) {
  const found = new Map();
  for (const match of String(html ?? '').matchAll(OPINION_LINK)) {
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || found.has(number)) continue;
    const slug = match[2] ? match[2].replace(/^-+|-+$/g, '') : '';
    found.set(number, { number, title: titleOf(slug, number), url: `https://nysba.org/ethics-opinion-${number}${slug ? `-${slug}` : ''}/` });
  }
  return [...found.values()].sort((a, b) => b.number - a.number);
}

export function unseenOpinions(source, opinions) {
  const from = Number(source?.watch_from) || 0;
  const seen = new Set(Array.isArray(source?.seen) ? source.seen : []);
  return (opinions ?? []).filter(opinion => opinion.number >= from && !seen.has(opinion.number));
}

export async function readOpinionListing(source, { fetchImpl, signal, timeoutMs } = {}) {
  const send = fetchImpl ?? globalThis.fetch;
  // The request, and the reading of its body, are raced against the abort, so that a fetch that ignores the signal still ends.
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([timer.signal, signal]) : timer.signal;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('aborted'));
    if (combined.aborted) onAbort(); else combined.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  let html;
  try {
    const response = await Promise.race([send(String(source?.url), { signal: combined, redirect: 'error' }), aborted]);
    if (response?.status !== 200) return failure(`status ${response?.status}`);
    html = await Promise.race([response.text(), aborted]);
  } catch {
    return failure(timer.signal.aborted ? 'the request timed out' : 'the request failed');
  } finally {
    clearTimeout(timeout);
    combined.removeEventListener('abort', onAbort);
  }
  const listed = parseOpinionList(html);
  if (!listed.length) return failure('the page listed no opinions');
  const opinions = unseenOpinions(source, listed);
  const text = opinions.length ? opinions.map(o => `${o.number} ${o.title} ${o.url}`).join('\n') : NO_NEW_OPINIONS;
  return { ok: true, text, opinions, title: '', activeDate: null, repealed: false, repealedDate: null };
}
