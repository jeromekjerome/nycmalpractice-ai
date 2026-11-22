// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// What is known about each model the app can call, in one place: who sells it, what it costs, and how it is
// asked. Prices and the spending caps read from here, so adding a model is one entry.
//
//   provider    'openai', 'anthropic' or 'google'
//   price       dollars per million tokens, input then output: the standard rate the provider publishes
//   reasoning   true for a model that thinks before it writes (it takes max_completion_tokens, not max_tokens,
//               and only the default temperature)
//   priceFrom   { 'YYYY-MM-DD': [in, out] }: a price that takes the place of `price` from that day (a day the provider has
//               announced). Read a price only through priceOn(), never `price` itself.
//   embedding   true for an embedding model, which the chat jobs and the health check must tell apart
//   effort      { reply, small }: the thinking effort asked for the reply and for the small jobs, where the
//               provider takes one
//   retiresOn   'YYYY-MM-DD', the day the provider shuts the model down
//
// OpenAI prices were read from developers.openai.com/api/docs/pricing on 2026-11-20, Anthropic's from the address
// beside its entries.
//
// OpenAI shuts down the first four on 14 January 2027 (developers.openai.com/api/docs/deprecations, read 2026-11-19).
// They stay here because plan 1's recorded measurement runs are priced from them; a chain cannot be saved with them
// (model-settings.js refuses a model with 60 days or fewer left).
export const MODELS = Object.freeze({
  'gpt-4o': { provider: 'openai', price: [2.50, 10.00], retiresOn: '2027-01-14' },
  'gpt-4o-mini': { provider: 'openai', price: [0.15, 0.60], retiresOn: '2027-01-14' },
  'gpt-4.1': { provider: 'openai', price: [2.00, 8.00], retiresOn: '2027-01-14' },
  'gpt-4.1-mini': { provider: 'openai', price: [0.40, 1.60], retiresOn: '2027-01-14' },
  'gpt-5.4': { provider: 'openai', price: [2.50, 15.00], reasoning: true },
  'gpt-5.4-mini': { provider: 'openai', price: [0.75, 4.50], reasoning: true },
  'gpt-5.4-nano': { provider: 'openai', price: [0.20, 1.25], reasoning: true },
  'gpt-6.2-sol': { provider: 'openai', price: [2.00, 10.00], reasoning: true },
  'gpt-6.1-terra': { provider: 'openai', price: [1.00, 5.00], reasoning: true },
  'gpt-6-luna': { provider: 'openai', price: [0.10, 0.50], reasoning: true },
  'text-embedding-3-small': { provider: 'openai', price: [0.02, 0], embedding: true },
  'text-embedding-3-large': { provider: 'openai', price: [0.13, 0], embedding: true },
  // Anthropic: standard API prices per million tokens, input then output, from platform.claude.com/docs/en/about-claude/pricing.md
  // read on 2026-11-21. Haiku 5.5's are for prompts up to 100,000 tokens (over that it is 0.50 and 2.50, which no job of
  // this app comes near). The reply effort was measured at medium and at low (runs reply-claude-<model> and
  // reply-claude-<model>-low, the small effort at low only, in small-claude-haiku-5-5), and each entry records the one it was
  // chosen at. Haiku: medium, the better of its two efforts on the quality part of the bar, which neither meets: at low 2 turns
  // did not pass after the rewrite and 2 seminar turns failed, while medium passed every turn; but at medium 4 first drafts cited a
  // decision that was not among those the turn was given (each a real decision from the recorded CourtListener packets, given
  // on another turn: Xiao Jin v City of New York, McMullin v. Village of Spring Valley, Franco v. Half Moon Riv. Club twice), against 1
  // in today's worst run. The gate caught each and the rewrite removed it, and no served reply cites one. Its medium speed
  // (11.7 s) is over the 10 s a main model needs.
  // Sonnet: low, which did better on every rule (2 turns not passing against 3, 4 unanchored first drafts against 6, seminar
  // 100% against 71.4%, and a slowest tenth of 11.7 s against 15.8 s). Opus: low, with fewer cut-offs at the 20 s reply
  // limit (11 turns against 17); it is still too slow and serves as the quality reference only.
  'claude-sonnet-5-5': { provider: 'anthropic', price: [2.00, 10.00], effort: { reply: 'low', small: 'low' } },
  'claude-haiku-5-5': { provider: 'anthropic', price: [0.10, 0.50], effort: { reply: 'medium', small: 'low' } },
  'claude-opus-5-5': { provider: 'anthropic', price: [4.00, 20.00], effort: { reply: 'low', small: 'low' } },
  // Google: standard, paid tier, text, per million tokens, input then output (output includes thinking), from
  // ai.google.dev/gemini-api/docs/pricing (now served at aistudio.google.com/docs/pricing), read on 2026-11-21. Gemini 3.8
  // Flash is 0.75 and 3.75 "through December 31, 2026" and 1.50 and 7.50 "starting January 1, 2027": `price` is the one in
  // force today, and priceFrom carries the announced one with its day. Neither model has a price that rises with the prompt's
  // size. The effort is the one today's OpenAI models run at; both Gemini models were measured at low only (reply-gemini-3.8-flash,
  // reply-gemini-3.5-flash-lite, small-gemini-3.5-flash-lite) and no other effort was tried.
  'gemini-3.8-flash': { provider: 'google', price: [0.75, 3.75], priceFrom: { '2027-01-01': [1.50, 7.50] }, effort: { reply: 'low', small: 'low' } },
  'gemini-3.5-flash-lite': { provider: 'google', price: [0.30, 2.50], effort: { reply: 'low', small: 'low' } },
});

// An entry serves its own name and that name's dated snapshots (gpt-4o-2024-08-06), and nothing else. A name that
// merely begins with a registered one (gpt-4o-realtime-preview, gpt-5.4-pro) is a different model at a different
// price, usually a higher one: counting it at the shorter name's price would under-count against the cap.
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

function registered(name) {
  return Object.hasOwn(MODELS, name) ? MODELS[name] : null;
}

export function entryFor(model) {
  const name = String(model || '');
  return registered(name) || registered(name.replace(DATED_SNAPSHOT, ''));
}

export function providerOf(model) {
  return entryFor(model)?.provider ?? null;
}

// The price of a model on a day ('YYYY-MM-DD', today's by default, in UTC): its `price`, or the latest priceFrom whose day
// has come. The one place a price is read, so that a price the provider has announced takes effect on its day without
// anyone remembering to edit it: the spending caps, the measurement's estimates and its report all go through here.
// null for a model with no price.
export function priceOn(model, day = new Date().toISOString().slice(0, 10)) {
  const entry = entryFor(model);
  if (!Array.isArray(entry?.price)) return null;
  const due = Object.keys(entry.priceFrom ?? {}).filter(from => from <= day).sort().at(-1);
  return due ? entry.priceFrom[due] : entry.price;
}
