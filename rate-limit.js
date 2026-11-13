// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// Per-client limits for the endpoints that cost money or send messages (OpenAI, Twilio, email).
// The counts live in memory on each server instance and are never stored. On Vercel one instance
// serves many requests, so this stops a single client looping on an endpoint, though a client whose
// requests spread over many instances can send more. The per-firm and per-phone limits on
// verification texts are kept in the database instead (firms.js).
const buckets = new Map();
const MAX_KEYS = 10_000;

export function clientKey(req) {
  // Vercel sets x-forwarded-for to the client's address and does not pass on one the client sent.
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

const enabled = () => process.env.NODE_ENV !== 'test' || process.env.RATE_LIMITS_IN_TESTS === '1';

// true when the request may go ahead. Each rule is [max requests, window in ms]; all must pass.
export function allow(name, key, rules) {
  if (!enabled()) return true;
  const now = Date.now();
  const id = `${name}:${key}`;
  let hits = buckets.get(id);
  if (!hits) {
    if (buckets.size >= MAX_KEYS) buckets.delete(buckets.keys().next().value);
    hits = [];
    buckets.set(id, hits);
  }
  const longest = Math.max(...rules.map(([, windowMs]) => windowMs));
  while (hits.length && now - hits[0] > longest) hits.shift();
  for (const [max, windowMs] of rules) {
    if (hits.filter(time => now - time <= windowMs).length >= max) return false;
  }
  hits.push(now);
  return true;
}

export function resetRateLimits() {
  buckets.clear();
}

// Express middleware: answers 429 while the client is over the limit.
export function rateLimit(name, rules, message = 'Too many requests. Please wait a few minutes and try again.') {
  return (req, res, next) => (allow(name, clientKey(req), rules) ? next() : res.status(429).json({ error: message }));
}
