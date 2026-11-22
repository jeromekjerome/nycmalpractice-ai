// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// A provider can quote a key back in an error ("Incorrect API key provided: sk-..."). Nothing shaped like one is
// logged, emailed or kept: OpenAI's keys and Anthropic's (sk-ant-..., which the same pattern takes whole), Google's (AIza
// and the thirty or more characters after it), and the forty hexadecimal characters of a CourtListener
// token. The exact value of every configured secret setting is withheld too, whatever its shape.
//
// This is a file of its own, with no imports, because both providers.js (which reaches the database) and the
// measurement's guard (measure/guard-fetch.mjs, which must be installed before anything reaches the database) need
// it, and the guard cannot import providers.js. providers.js exports it under the same name.
// The settings that hold a secret, whatever shape the secret has: Google's newer keys, for one, have a dot and no prefix
// any pattern could know. Their exact values are withheld as well, read at the time of the call. A value shorter than
// this is no secret worth the risk of blanking out ordinary words.
const SECRET_SETTINGS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'COURTLISTENER_TOKEN',
  'ADMIN_SECRET', 'ADMIN_SECRET_FOR_UPLOAD', 'CRON_SECRET',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'TWILIO_AUTH_TOKEN', 'SMTP_PASS',
  'BACKUP_SECRET_ACCESS_KEY', 'BACKUP_ENCRYPTION_KEY', 'ETHEREAL_API_KEY',
];
const SHORTEST_SECRET = 8;

export function withoutKeys(text) {
  let clean = String(text ?? '');
  // The longest first, so that a secret that holds another is withheld whole.
  const secrets = SECRET_SETTINGS.map(name => process.env[name]).filter(value => typeof value === 'string' && value.length >= SHORTEST_SECRET);
  for (const secret of secrets.sort((a, b) => b.length - a.length)) clean = clean.split(secret).join('[key withheld]');
  return clean
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_*-]{8,}/g, '[key withheld]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '[key withheld]')
    .replace(/\b[0-9a-f]{40}\b/gi, '[key withheld]');
}
