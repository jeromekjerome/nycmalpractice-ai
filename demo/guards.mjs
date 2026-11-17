// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// What keeps the demo tools away from real people. The seed writes only to a database that is not the live one and
// is empty or already marked as the demo; the persona runner talks only to a site that says it is the demo copy.

export const LIVE_HOSTS = ['nycmalpractice-ai.vercel.app', 'nycmalpractice.ai', 'www.nycmalpractice.ai'];

// Neon gives a database two host names, direct and pooled ("-pooler"); both name the same database.
function databaseIdentity(url) {
  const parsed = new URL(url);
  return `${parsed.hostname.replace('-pooler.', '.')}${parsed.pathname}`.toLowerCase();
}

/** Why the seed must not write to `demoUrl`, or null when it may. `liveUrl` is the live DATABASE_URL, if known. */
export function databaseRefusal(demoUrl, liveUrl) {
  if (!demoUrl) return 'Set DEMO_DATABASE_URL to the demo database. The seed never uses DATABASE_URL.';
  let demo;
  try { demo = databaseIdentity(demoUrl); } catch { return 'DEMO_DATABASE_URL is not a database URL.'; }
  if (liveUrl) {
    try { if (databaseIdentity(liveUrl) === demo) return 'DEMO_DATABASE_URL is the live database. Refusing.'; } catch { /* not comparable */ }
  }
  return null;
}

/** Why the seed must not use this Stripe key, or null. No key at all is allowed: firms then have no billing. */
export function stripeKeyRefusal(key) {
  if (key && /^(sk|rk)_live_/.test(key)) return 'That is a live Stripe key. The demo uses test keys only (sk_test_...).';
  if (key && !/^(sk|rk)_test_/.test(key)) return 'That does not look like a Stripe test key (sk_test_...).';
  return null;
}

/** Why the persona runner must not send to `baseUrl`, or null. The site must also say it is the demo (/api/site-mode). */
export function siteRefusal(baseUrl) {
  let parsed;
  try { parsed = new URL(baseUrl); } catch { return 'Give the demo site\'s address, e.g. https://nycmalpractice-demo.vercel.app'; }
  if (LIVE_HOSTS.includes(parsed.hostname)) return 'That is the live site. The persona runner talks only to the demo copy.';
  return null;
}
