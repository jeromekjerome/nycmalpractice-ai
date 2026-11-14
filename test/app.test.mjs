import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { startServer } from './helpers.mjs';
import { test } from './runner.mjs';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgres://user:pass@localhost:5432/testdb';
process.env.OPENAI_API_KEY ||= 'test-openai-key';
process.env.STRIPE_SECRET_KEY ||= 'sk_test_123';
process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_test_123';
process.env.TWILIO_ACCOUNT_SID ||= 'AC123';
process.env.TWILIO_AUTH_TOKEN ||= 'twilio-token';
process.env.TWILIO_PHONE_NUMBER ||= '+15555550123';
process.env.CRON_SECRET ||= 'cron-secret';
process.env.ADMIN_SECRET ||= 'admin-secret';
process.env.APP_URL ||= 'https://example.test';
process.env.SMTP_HOST ||= 'smtp.example.test';
process.env.SMTP_PORT ||= '465';
process.env.SMTP_USER ||= 'ops@example.test';
process.env.SMTP_PASS ||= 'password';
process.env.NOTIFICATION_EMAIL ||= 'ops@example.test';
// Set before server.js loads dotenv, so a real token in a local .env is never used by the tests.
process.env.COURTLISTENER_TOKEN ||= 'cl-test-token';

// ─── Offline harness ─────────────────────────────────────────────────────────
// Every outbound HTTP call the app makes (OpenAI SDK, CourtListener, Neon's HTTP driver) goes
// through global fetch. Routing it through a swappable function lets the tests below run the
// real request path end to end without touching the network. It must be installed before
// server.js is imported, because the OpenAI client captures fetch when it is constructed.
const realFetch = globalThis.fetch;
let activeFetch = realFetch;
globalThis.fetch = (...args) => activeFetch(...args);

const { default: app } = await import('../server.js');
const { clearSearchCache, extractCaseType, searchMalpracticeCases } = await import('../courtlistener.js');
const { scoreLead } = await import('../auction.js');
const { CONVERSATION_RETENTION_DAYS } = await import('../retention.js');
const { CONTACT_CONSENT_TEXT } = await import('../site.js');
const { getBlogPosts, getBlogPost } = await import('../blog.js');
const { default: blogApp } = await import('../blog-server.js');

async function getJsonIfPossible(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
  return response.json();
}

test('health or case types endpoint responds', async () => {
  const server = await startServer(app);
  try {
    const healthResponse = await fetch(`${server.baseUrl}/health`);
    const healthBody = await getJsonIfPossible(healthResponse);

    if (healthBody) {
      assert.equal(healthResponse.status, 200);
      assert.equal(healthBody.status, 'ok');
      assert.match(healthBody.service, /-ai$/);
      return;
    }

    const caseTypesResponse = await fetch(`${server.baseUrl}/api/case-types`);
    const caseTypesBody = await caseTypesResponse.json();
    assert.equal(caseTypesResponse.status, 200);
    assert.ok(Array.isArray(caseTypesBody.caseTypes));
    assert.ok(caseTypesBody.caseTypes.length > 0);
  } finally {
    await server.close();
  }
});

test('ask validates required question and session id', async () => {
  const server = await startServer(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '', sessionId: '' }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: 'question and sessionId required' });
  } finally {
    await server.close();
  }
});

test('firm registration validates required fields', async () => {
  const server = await startServer(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/firms/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test Firm' }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: 'name, email, phone required' });
  } finally {
    await server.close();
  }
});

test('phone verification validates required fields', async () => {
  const server = await startServer(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/firms/verify-phone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ firmId: 1 }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: 'firmId and code required' });
  } finally {
    await server.close();
  }
});

test('resend code validates firm id', async () => {
  const server = await startServer(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/firms/resend-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: 'firmId required' });
  } finally {
    await server.close();
  }
});

test('billing checkout validates firm id', async () => {
  const server = await startServer(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: 'firmId required' });
  } finally {
    await server.close();
  }
});

test('a cron endpoint rejects missing authorization', async () => {
  const server = await startServer(app);
  try {
    const primaryResponse = await fetch(`${server.baseUrl}/api/cron`);
    const primaryBody = await getJsonIfPossible(primaryResponse);

    if (primaryBody) {
      assert.equal(primaryResponse.status, 401);
      assert.deepEqual(primaryBody, { error: 'Unauthorized' });
      return;
    }

    const fallbackResponse = await fetch(`${server.baseUrl}/api/cron/close-auctions`);
    const fallbackBody = await fallbackResponse.json();
    assert.equal(fallbackResponse.status, 401);
    assert.deepEqual(fallbackBody, { error: 'Unauthorized' });
  } finally {
    await server.close();
  }
});

test('admin firms endpoint rejects missing admin secret', async () => {
  const server = await startServer(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/admin/firms`);
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: 'Unauthorized' });
  } finally {
    await server.close();
  }
});

test('reset session succeeds without a session id', async () => {
  const server = await startServer(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/reset-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true });
  } finally {
    await server.close();
  }
});

// ─── Offline world for end-to-end runs of /api/ask ────────────────────────────

const DISCLAIMER = 'This is general information, not legal advice.';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function chatCompletion(content) {
  return jsonResponse({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** Run fn with every outbound request answered by handler(url, init). The local test server passes through. */
async function withOutboundHttp(handler, fn) {
  const previous = activeFetch;
  activeFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    return handler(url, init);
  };
  try {
    return await fn();
  } finally {
    activeFetch = previous;
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return predicate();
}

// Lead notices go to the operator while no firm subscribes; with SMTP_USER unset they are only logged,
// so no test opens a connection to a mail server.
async function withoutMail(fn) {
  const smtpUser = process.env.SMTP_USER;
  delete process.env.SMTP_USER;
  try {
    return await fn();
  } finally {
    process.env.SMTP_USER = smtpUser;
  }
}

const EMPTY_ROWS = { fields: [], rows: [], command: 'SELECT', rowCount: 0, rowAsArray: true };

// A fictional decision in CourtListener's v4 search format.
const CL_RESULT = {
  caseName: 'Patient v. General Hospital',
  citation: ['200 A.D.3d 100', '2022 NY Slip Op 01234'],
  court: 'Appellate Division of the Supreme Court of the State of New York',
  court_id: 'nyappdiv',
  dateFiled: '2022-03-01',
  absolute_url: '/opinion/1/patient-v-general-hospital/',
  // v4 nests the snippet under opinions[] and wraps matches in <mark>.
  opinions: [{ snippet: 'The failure to <mark>diagnose</mark>   was a departure\n from accepted practice.' }],
};

/**
 * A scripted outside world: OpenAI (routed by which prompt is calling), CourtListener search, and
 * Neon's HTTP SQL endpoint. Records every call.
 */
function fakeWorld({
  answer = `I am so sorry this happened. ${DISCLAIMER}`,
  classification = { type: 'misdiagnosis', terms: 'delayed cancer diagnosis' },
  nyResults = [CL_RESULT],
  nationalResults = [],
  leadScore = { viable: false, score: 10, confidence: 0.2 },
  caseAnalysis = { score: 6, verdict: 'moderate', complexityEstimate: null, solWarning: null, strengths: [], weaknesses: [] },
} = {}) {
  const calls = { openai: [], courtListener: [], sql: [] };

  const handler = async (url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';

    if (url.startsWith('https://api.openai.com/')) {
      const request = JSON.parse(body);
      const first = String(request.messages[0].content);
      let kind;
      let content;
      if (first.startsWith('Classify this NYC malpractice inquiry')) { kind = 'classify'; content = JSON.stringify(classification); }
      else if (first.startsWith('You are a NYC medical malpractice case evaluator')) { kind = 'scoreLead'; content = JSON.stringify(leadScore); }
      else if (first.startsWith('You are a NYC medical malpractice case analyst')) { kind = 'caseAnalysis'; content = JSON.stringify(caseAnalysis); }
      else { kind = 'answer'; content = answer; }
      calls.openai.push({ kind, model: request.model, request });
      return chatCompletion(content);
    }

    if (url.startsWith('https://www.courtlistener.com/api/rest/v4/search/')) {
      const params = new URL(url).searchParams;
      calls.courtListener.push({ court: params.get('court'), q: params.get('q') });
      return jsonResponse({ results: params.has('court') ? nyResults : nationalResults });
    }

    if (url.endsWith('/sql')) {
      const { query, params } = JSON.parse(body);
      calls.sql.push({ query: query.replace(/\s+/g, ' ').trim(), params });
      if (/INSERT INTO auctions/.test(query)) {
        return jsonResponse({
          fields: ['id', 'tier', 'quality_score', 'lead_preview', 'case_type', 'closes_at'].map(name => ({ name, dataTypeID: 25 })),
          rows: [['101', 'hot', '84', 'preview', 'misdiagnosis', '2030-01-01T00:00:00Z']],
          command: 'INSERT',
          rowCount: 1,
          rowAsArray: true,
        });
      }
      return jsonResponse(EMPTY_ROWS);
    }

    throw new Error(`Unexpected outbound request in test: ${url}`);
  };

  return { calls, handler };
}

async function postJson(baseUrl, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

// A fake world whose hand-off statements take a moment, recording when each one starts and ends.
function slowFollowUpWorld(world, delayMs) {
  const started = [];
  const finished = [];
  const handler = async (url, init) => {
    const query = url.endsWith('/sql') ? JSON.parse(init.body).query.replace(/\s+/g, ' ') : '';
    const kind = /INSERT INTO auctions/.test(query) ? 'auction'
      : /INSERT INTO conversations \(session_id, mode/.test(query) ? 'conversation'
      : /FROM firms WHERE active/.test(query) ? 'firms'
      : null;
    if (!kind) return world.handler(url, init);
    started.push(kind);
    await new Promise(resolve => setTimeout(resolve, typeof delayMs === 'function' ? delayMs(kind) : delayMs));
    const response = await world.handler(url, init);
    finished.push(kind);
    return response;
  };
  return { started, finished, handler };
}

const QUALIFYING_HISTORY = [
  { role: 'user', content: 'My doctor missed a tumor on my scan in 2024.' },
  { role: 'assistant', content: 'I am so sorry. When did you learn about it?' },
];
const leadScoreOf = score => ({
  viable: true, score, confidence: 0.9, preview: 'Delayed cancer diagnosis after a misread scan.',
  dimensions: { injury_severity: 8, causation_clarity: 7, sol_status: 9, expert_viability: 7, damages_magnitude: 8 },
});

// ─── The nightly job ──────────────────────────────────────────────────────────

test('GET /api/cron rejects a wrong bearer token', async () => {
  const server = await startServer(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/cron`, { headers: { authorization: 'Bearer not-the-secret' } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  } finally {
    await server.close();
  }
});

test('GET /api/cron with the cron secret closes auctions, declines overdue leads and resets declines', async () => {
  const world = fakeWorld();
  const server = await startServer(app);
  try {
    await withOutboundHttp(world.handler, async () => {
      const response = await fetch(`${server.baseUrl}/api/cron`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, closed: 0, declined: 0, purged: { conversations: 0, messages: 0 } });
    });
    const queries = world.calls.sql.map(call => call.query);
    assert.ok(queries.some(query => /FROM auctions WHERE status = 'open' AND closes_at < NOW\(\)/.test(query)), 'expired auctions were not looked up');
    assert.ok(queries.some(query => /^UPDATE leads SET status = 'declined', declined_at = NOW\(\) WHERE status = 'pending' AND accept_deadline < NOW\(\) RETURNING/.test(query)), 'overdue leads were not declined');
    assert.ok(queries.some(query => /^UPDATE firms SET auction_decline_count = \(SELECT count\(\*\) FROM leads l WHERE l\.firm_id = firms\.id AND l\.status = 'declined' AND l\.auction_id IS NOT NULL AND l\.declined_at > NOW\(\) - INTERVAL '30 days'\)/.test(query)), 'decline counts were not brought up to date');
  } finally {
    await server.close();
  }
});

test('the nightly job deletes conversations after the 90 days the privacy policy promises', async () => {
  const world = fakeWorld();
  const server = await startServer(app);
  try {
    await withOutboundHttp(world.handler, async () => {
      const response = await fetch(`${server.baseUrl}/api/cron`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
      assert.equal(response.status, 200);
    });
    const purge = world.calls.sql.find(call => /^DELETE FROM conversations WHERE updated_at < NOW\(\) - make_interval\(days => \$1\)/.test(call.query));
    assert.ok(purge, 'expired conversations were not deleted');
    assert.equal(String(purge.params[0]), '90');
    const scrub = world.calls.sql.find(call => /^UPDATE user_interactions SET question = NULL WHERE question IS NOT NULL AND created_at < NOW\(\) - make_interval\(days => \$1\)/.test(call.query));
    assert.ok(scrub, 'the text of expired messages was not removed');
    assert.equal(String(scrub.params[0]), '90');
    // Lead records sold to firms are kept for 3 years, so the nightly job never deletes them.
    assert.ok(!world.calls.sql.some(call => /DELETE FROM (auctions|leads)/.test(call.query)));
  } finally {
    await server.close();
  }

  // The number in the code is the number in the policy.
  assert.equal(CONVERSATION_RETENTION_DAYS, 90);
  const policy = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(policy.includes(`retained for ${CONVERSATION_RETENTION_DAYS} days after your last message`));
  assert.ok(policy.includes('the conversation and the text of your messages are automatically deleted'));
});

// ─── Work that must finish before the reply ───────────────────────────────────

test('POST /api/ask saves the conversation and the lead score before it replies, and sends nothing to firms', async () => {
  // A lead goes to firms only after the contact form (see /api/contact).
  await withoutMail(async () => {
    clearSearchCache();
    const world = fakeWorld({ leadScore: leadScoreOf(84) });
    const slow = slowFollowUpWorld(world, 120);
    const server = await startServer(app);
    try {
      await withOutboundHttp(slow.handler, async () => {
        const { response, body } = await postJson(server.baseUrl, '/api/ask', {
          question: 'I found out in March that the spot on my scan was cancer.',
          mode: 'personal',
          sessionId: 'sess-score-kept',
          history: QUALIFYING_HISTORY,
        });
        assert.equal(response.status, 200);
        assert.equal(body.leadTier, 'hot');
        assert.equal(body.contactForm, false, 'the contact form was offered before the referral step');
        // Checked at the moment the reply arrives, with no waiting.
        assert.ok(slow.finished.includes('conversation'), 'the conversation was not saved before the reply');
      });
      const upsert = world.calls.sql.find(call => /^INSERT INTO conversations \(session_id, mode/.test(call.query));
      const kept = JSON.parse(upsert.params.find(param => typeof param === 'string' && param.startsWith('{"viable"')));
      assert.equal(kept.tier, 'hot');
      assert.ok(kept.scoredAt, 'the score is kept with the time it was given');
      assert.ok(!world.calls.sql.some(call => /INSERT INTO auctions|FROM firms WHERE active/.test(call.query)), 'a lead went to firms without the visitor asking');
    } finally {
      await server.close();
    }
  });
});

test('POST /api/ask still replies when saving the conversation fails', async () => {
  clearSearchCache();
  const world = fakeWorld({ answer: `The scan should have been reported. ${DISCLAIMER}` });
  const failing = async (url, init) => {
    if (url.endsWith('/sql') && /INSERT INTO conversations \(session_id, mode/.test(JSON.parse(init.body).query)) {
      return jsonResponse({ message: 'database unavailable' }, 500);
    }
    return world.handler(url, init);
  };
  const server = await startServer(app);
  try {
    await withOutboundHttp(failing, async () => {
      const { response, body } = await postJson(server.baseUrl, '/api/ask', {
        question: 'I found out in March that the spot on my scan was cancer.',
        mode: 'personal',
        sessionId: 'sess-save-failing',
        history: QUALIFYING_HISTORY,
      });
      assert.equal(response.status, 200);
      assert.ok(body.answer.includes('The scan should have been reported.'));
    });
  } finally {
    await server.close();
  }
});

// ─── Contact form and consent ─────────────────────────────────────────────────

const JSONB = 3802;
const TEXT = 25;
const INT = 23;
const TIMESTAMPTZ = 1184;

function rowsResponse(fields, rows, command = 'SELECT') {
  return jsonResponse({ fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })), rows, command, rowCount: rows.length, rowAsArray: true });
}

const CONTACT_HISTORY = [
  ...QUALIFYING_HISTORY,
  { role: 'user', content: 'Yes, I would like to talk to a lawyer.' },
  { role: 'assistant', content: 'You can use the contact form below this reply.' },
];

/** The outside world for /api/contact: a saved conversation, optional firms, and the lead tables. */
function contactWorld({ leadScore = null, alreadyHandedOff = false, firms = [], conversation = true } = {}) {
  const world = fakeWorld();
  const handler = async (url, init) => {
    if (url.endsWith('/sql')) {
      const { query, params } = JSON.parse(init.body);
      const q = query.replace(/\s+/g, ' ').trim();
      const record = () => world.calls.sql.push({ query: q, params });
      if (/^SELECT mode, case_type, history, lead_score FROM conversations/.test(q)) {
        record();
        return conversation
          ? rowsResponse([['mode', TEXT], ['case_type', TEXT], ['history', JSONB], ['lead_score', JSONB]],
            [['personal', 'misdiagnosis', JSON.stringify(CONTACT_HISTORY), leadScore ? JSON.stringify(leadScore) : null]])
          : rowsResponse([], []);
      }
      if (/^UPDATE conversations SET name/.test(q)) {
        record();
        return rowsResponse([['contact_consent_at', TIMESTAMPTZ]], [['2026-11-14 10:00:00+00']], 'UPDATE');
      }
      if (/^SELECT 1 FROM user_interactions/.test(q)) {
        record();
        return alreadyHandedOff ? rowsResponse([['flag', INT]], [['1']]) : rowsResponse([], []);
      }
      if (/FROM firms WHERE active/.test(q)) {
        record();
        return rowsResponse([['id', INT], ['name', TEXT], ['email', TEXT], ['stripe_customer_id', TEXT], ['stripe_payment_method_id', TEXT]],
          firms.map(firm => [String(firm.id), firm.name, firm.email, null, null]));
      }
      if (/^INSERT INTO leads/.test(q)) {
        record();
        return rowsResponse([['id', INT]], [['501']], 'INSERT');
      }
    }
    return world.handler(url, init);
  };
  return { calls: world.calls, handler };
}

const CONTACT = { name: '  Jane   Roe ', phone: '(555) 123-4567', bestTime: 'weekday mornings', consent: true };
const leadDataOf = call => JSON.parse(call.params.find(param => typeof param === 'string' && param.startsWith('{"caseType"')));

test('POST /api/contact checks the name, the phone number and the consent', async () => {
  const world = contactWorld({ leadScore: leadScoreOf(84) });
  const server = await startServer(app);
  try {
    await withOutboundHttp(world.handler, async () => {
      for (const [change, error] of [
        [{ name: '' }, 'Please enter your name.'],
        [{ phone: '555-1234' }, 'Please enter a 10-digit phone number.'],
        [{ consent: false }, 'Please check the box to agree to be contacted.'],
        [{ consent: 'yes' }, 'Please check the box to agree to be contacted.'],
      ]) {
        const { response, body } = await postJson(server.baseUrl, '/api/contact', { sessionId: 'sess-contact-checks', ...CONTACT, ...change });
        assert.equal(response.status, 400, JSON.stringify(change));
        assert.equal(body.error, error);
      }
    });
    assert.ok(!world.calls.sql.some(call => /UPDATE conversations SET name/.test(call.query)), 'invalid details were saved');
  } finally {
    await server.close();
  }

  const empty = contactWorld({ conversation: false });
  const again = await startServer(app);
  try {
    await withOutboundHttp(empty.handler, async () => {
      const { response } = await postJson(again.baseUrl, '/api/contact', { sessionId: 'sess-no-conversation', ...CONTACT });
      assert.equal(response.status, 404);
    });
  } finally {
    await again.close();
  }
});

test('POST /api/contact with consent hands the lead off with the contact details before it replies', async () => {
  await withoutMail(async () => {
    // A hot lead opens an auction; the winner will see the details.
    const hot = contactWorld({ leadScore: { ...leadScoreOf(84), tier: 'hot', reserve: 200, scoredAt: '2026-11-14T09:59:00Z' } });
    const slowHot = slowFollowUpWorld(hot, 120);
    let server = await startServer(app);
    try {
      await withOutboundHttp(slowHot.handler, async () => {
        const { response, body } = await postJson(server.baseUrl, '/api/contact', { sessionId: 'sess-contact-hot', ...CONTACT });
        assert.equal(response.status, 200);
        assert.deepEqual(body, { ok: true });
        assert.ok(slowHot.finished.includes('auction'), 'the auction had not been created before the reply');
      });
    } finally {
      await server.close();
    }
    const saved = hot.calls.sql.find(call => /^UPDATE conversations SET name/.test(call.query));
    assert.ok(saved.params.includes('Jane Roe'));
    assert.ok(saved.params.includes('5551234567'));
    assert.ok(saved.params.includes(CONTACT_CONSENT_TEXT), 'the consent text stored is not the one the page shows');
    const auction = leadDataOf(hot.calls.sql.find(call => /INSERT INTO auctions/.test(call.query)));
    assert.deepEqual(auction.contact, { name: 'Jane Roe', phone: '5551234567', bestTime: 'weekday mornings', consentedAt: '2026-11-14T10:00:00.000Z' });
    assert.equal(auction.history.length, CONTACT_HISTORY.length);
    assert.equal(auction.preview, 'Delayed cancer diagnosis after a misread scan.');

    // A cold lead goes to each matching firm, and the lead row keeps what the firm bought.
    const cold = contactWorld({ leadScore: { ...leadScoreOf(60), tier: 'cold', reserve: 25 }, firms: [{ id: 7, name: 'Test Firm', email: 'firm@example.test' }] });
    server = await startServer(app);
    try {
      await withOutboundHttp(cold.handler, async () => {
        const { response } = await postJson(server.baseUrl, '/api/contact', { sessionId: 'sess-contact-cold', ...CONTACT });
        assert.equal(response.status, 200);
      });
    } finally {
      await server.close();
    }
    const lead = leadDataOf(cold.calls.sql.find(call => /^INSERT INTO leads/.test(call.query)));
    assert.equal(lead.contact.phone, '5551234567');
    assert.equal(lead.score, 60);
  });
});

test('POST /api/contact sends nothing to firms without a qualifying score or a second time', async () => {
  await withoutMail(async () => {
    for (const [label, options] of [
      ['no qualifying score', { leadScore: null }],
      ['already handed off', { leadScore: leadScoreOf(84), alreadyHandedOff: true }],
    ]) {
      const world = contactWorld(options);
      const server = await startServer(app);
      try {
        await withOutboundHttp(world.handler, async () => {
          const { response, body } = await postJson(server.baseUrl, '/api/contact', { sessionId: 'sess-contact-' + label.replace(/ /g, '-'), ...CONTACT });
          assert.equal(response.status, 200, label);
          assert.deepEqual(body, { ok: true });
        });
      } finally {
        await server.close();
      }
      assert.ok(world.calls.sql.some(call => /^UPDATE conversations SET name/.test(call.query)), `${label}: the request was not recorded`);
      assert.ok(!world.calls.sql.some(call => /INSERT INTO (auctions|leads)/.test(call.query)), `${label}: a lead went to firms`);
    }
  });
});

test('POST /api/contact still replies when the lead hand-off outlasts the cap or fails', async () => {
  const previousCap = process.env.ASK_FOLLOW_UP_WORK_CAP_MS;
  process.env.ASK_FOLLOW_UP_WORK_CAP_MS = '100';
  const server = await startServer(app);
  try {
    await withoutMail(async () => {
      // 1) A hand-off that takes far longer than the cap: the reply does not wait for it.
      const world = contactWorld({ leadScore: { ...leadScoreOf(84), tier: 'hot', reserve: 200 } });
      const slow = slowFollowUpWorld(world, kind => (kind === 'auction' ? 1500 : 0));
      await withOutboundHttp(slow.handler, async () => {
        const { response, body } = await postJson(server.baseUrl, '/api/contact', { sessionId: 'sess-contact-capped', ...CONTACT });
        assert.equal(response.status, 200);
        assert.deepEqual(body, { ok: true });
        assert.ok(slow.started.includes('auction'), 'the hand-off was started');
        assert.ok(!slow.finished.includes('auction'), 'the reply waited for a hand-off that outlasted the cap');
        // Let the slow statement finish inside the fake world before it is torn down.
        assert.ok(await waitFor(() => slow.finished.includes('auction'), 5000));
      });

      // 2) A hand-off that fails: the request is still recorded and the visitor still gets an answer.
      const failingWorld = contactWorld({ leadScore: { ...leadScoreOf(84), tier: 'hot', reserve: 200 } });
      const failing = async (url, init) => {
        if (url.endsWith('/sql') && /INSERT INTO auctions/.test(JSON.parse(init.body).query)) {
          return jsonResponse({ message: 'database unavailable' }, 500);
        }
        return failingWorld.handler(url, init);
      };
      await withOutboundHttp(failing, async () => {
        const { response, body } = await postJson(server.baseUrl, '/api/contact', { sessionId: 'sess-contact-failing', ...CONTACT });
        assert.equal(response.status, 200);
        assert.deepEqual(body, { ok: true });
      });
    });
  } finally {
    await server.close();
    if (previousCap === undefined) delete process.env.ASK_FOLLOW_UP_WORK_CAP_MS;
    else process.env.ASK_FOLLOW_UP_WORK_CAP_MS = previousCap;
  }
});

test('GET /api/leads/:id shows a cold lead from the data kept on the lead', async () => {
  const leadData = { caseType: 'misdiagnosis', mode: 'personal', history: CONTACT_HISTORY, preview: 'Delayed cancer diagnosis.', score: 60, contact: { name: 'Jane Roe', phone: '5551234567', bestTime: null, consentedAt: '2026-11-14T10:00:00.000Z' } };
  const handler = async (url, init) => {
    const q = JSON.parse(init.body).query.replace(/\s+/g, ' ');
    if (/FROM firm_tokens/.test(q)) {
      return rowsResponse([['firm_id', INT], ['name', TEXT], ['cold_decline_count', INT], ['auction_decline_count', INT]], [['7', 'Test Firm', '0', '0']]);
    }
    if (/FROM leads WHERE id/.test(q)) {
      return rowsResponse(
        [['id', INT], ['status', TEXT], ['case_type', TEXT], ['tier', TEXT], ['price_paid', 1700], ['accept_deadline', TIMESTAMPTZ], ['auction_id', INT], ['lead_data', JSONB]],
        [['501', 'pending', 'misdiagnosis', 'cold', '25.00', '2030-01-01 00:00:00+00', null, JSON.stringify(leadData)]],
      );
    }
    return jsonResponse(EMPTY_ROWS);
  };
  const server = await startServer(app);
  try {
    await withOutboundHttp(handler, async () => {
      const response = await fetch(`${server.baseUrl}/api/leads/501?token=firm-token`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.tier, 'cold');
      assert.equal(body.leadData.contact.name, 'Jane Roe');
      assert.equal(body.leadData.history.length, CONTACT_HISTORY.length);
      assert.equal(body.leadData.tier, 'cold');
    });
  } finally {
    await server.close();
  }
});

test('the contact form shows the consent text the server stores, and the policy matches the flow', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(page.includes(CONTACT_CONSENT_TEXT), 'the page shows different consent wording from the one stored');
  const policy = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(policy, /Nothing about your case goes to a law firm unless you use the contact form and agree to be contacted/);
  assert.match(policy, /Firms pay us for these referrals/);
  assert.doesNotMatch(policy, /implicit consent/);
  assert.doesNotMatch(policy, /We do not sell your data\./);
});

// ─── Case law search ──────────────────────────────────────────────────────────

test('POST /api/ask searches New York courts first and falls back to a national search', async () => {
  clearSearchCache();
  const world = fakeWorld({ nyResults: [], nationalResults: [CL_RESULT] });
  const server = await startServer(app);
  try {
    await withOutboundHttp(world.handler, async () => {
      const { response, body } = await postJson(server.baseUrl, '/api/ask', {
        question: 'My radiologist missed a tumor.',
        mode: 'personal',
        sessionId: 'sess-search-ladder',
        history: [],
      });
      assert.equal(response.status, 200);
      assert.deepEqual(world.calls.courtListener.map(call => [call.court, call.q]), [
        ['ny nysupct nyappdiv', 'medical malpractice failure to diagnose (delayed OR cancer OR diagnosis)'],
        ['ny nysupct nyappdiv', 'medical malpractice failure to diagnose'],
        [null, 'medical malpractice failure to diagnose (delayed OR cancer OR diagnosis)'],
      ]);
      assert.equal(body.cases.length, 1);
      assert.equal(body.cases[0].scope, 'national');
      assert.equal(body.cases[0].snippet, 'The failure to diagnose was a departure from accepted practice.');
      assert.equal(body.cases[0].absoluteUrl, 'https://www.courtlistener.com/opinion/1/patient-v-general-hospital/');
      // The model is told the cases are not New York law, and is given every parallel citation.
      const system = world.calls.openai.find(call => call.kind === 'answer').request.messages[0].content;
      assert.ok(system.includes('persuasive authority only'));
      assert.ok(system.includes('Citation: 200 A.D.3d 100; 2022 NY Slip Op 01234'));
    });
  } finally {
    await server.close();
  }
});

test('POST /api/ask does not send the words a visitor typed to CourtListener when the classifier gives no search terms', async () => {
  // The visitor's message can hold a name and a phone number, and the search query goes to a third
  // party, so without usable terms from the classifier the search uses the case type's terms alone.
  clearSearchCache();
  const world = fakeWorld({ classification: { type: 'misdiagnosis', terms: ['missed', 'tumor'] } });
  const server = await startServer(app);
  try {
    await withOutboundHttp(world.handler, async () => {
      const { response } = await postJson(server.baseUrl, '/api/ask', {
        question: 'My name is Jane Roe, call me at 555-123-4567 about my missed tumor.',
        mode: 'personal',
        sessionId: 'sess-no-visitor-words',
        history: [],
      });
      assert.equal(response.status, 200);
      assert.ok(world.calls.courtListener.length > 0, 'a case search was made');
      for (const { q } of world.calls.courtListener) {
        assert.equal(q, 'medical malpractice failure to diagnose');
      }
    });
  } finally {
    await server.close();
  }
});

test('searchMalpracticeCases stops sending requests once CourtListener throttles the token', async () => {
  clearSearchCache();
  const requests = [];
  await withOutboundHttp(async url => {
    requests.push(url);
    return jsonResponse({ detail: 'Request was throttled.' }, 429);
  }, async () => {
    assert.deepEqual(await searchMalpracticeCases({ query: 'retained sponge after surgery', caseType: 'surgical_error' }), []);
  });
  assert.equal(requests.length, 1, 'a throttled token was asked again');
});

test('extractCaseType uses the aux model chain with failover', async () => {
  const modelsTried = [];
  const openai = {
    chat: {
      completions: {
        create: async request => {
          modelsTried.push(request.model);
          if (modelsTried.length === 1) throw Object.assign(new Error('The model does not exist'), { status: 404, code: 'model_not_found' });
          return { choices: [{ message: { content: '{"type":"birth_injury","terms":"shoulder dystocia delivery"}' } }] };
        },
      },
    },
  };
  assert.deepEqual(await extractCaseType('My baby was injured during delivery.', openai), { type: 'birth_injury', terms: 'shoulder dystocia delivery' });
  assert.equal(modelsTried.length, 2);
  assert.equal(modelsTried[0], process.env.OPENAI_MODEL_AUX || 'gpt-4o-mini');
  assert.notEqual(modelsTried[1], modelsTried[0]);

  // Every model failing, or an answer that is not an object, still yields a usable default.
  const fallback = { type: 'other', terms: 'medical malpractice standard of care' };
  const dead = { chat: { completions: { create: async () => { throw Object.assign(new Error('down'), { status: 503 }); } } } };
  assert.deepEqual(await extractCaseType('anything', dead), fallback);
  const listAnswer = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '["dental"]' } }] }) } } };
  assert.deepEqual(await extractCaseType('anything', listAnswer), fallback);
});

test('scoreLead uses the aux model chain with failover', async () => {
  const modelsTried = [];
  await withOutboundHttp(async (url, init) => {
    const request = JSON.parse(init.body);
    modelsTried.push(request.model);
    if (modelsTried.length === 1) return jsonResponse({ error: { message: 'The model does not exist', code: 'model_not_found' } }, 404);
    return chatCompletion(JSON.stringify(leadScoreOf(84)));
  }, async () => {
    const score = await scoreLead('I found out in March.', QUALIFYING_HISTORY, 'misdiagnosis', 'personal');
    assert.equal(score.tier, 'hot');
    assert.equal(score.reserve, 200);
  });
  assert.equal(modelsTried.length, 2);
  assert.equal(modelsTried[0], process.env.OPENAI_MODEL_AUX || 'gpt-4o-mini');
});

// ─── New York deadlines ───────────────────────────────────────────────────────

test('the malpractice prompts state the New York deadlines correctly', async () => {
  const expectations = {
    personal: {
      present: ["Lavern's Law", 'within 1 year of discovering the object', 'notice of claim within 90 days', 'never beyond 10 years after the malpractice', '50% or less at fault'],
      absent: ['no SOL if object left in body'],
    },
    estate: {
      present: ['2 years from date of death', "within 90 days of the estate representative's appointment", 'has been vetoed four times'],
      absent: [],
    },
  };
  for (const [mode, { present, absent }] of Object.entries(expectations)) {
    clearSearchCache();
    const world = fakeWorld();
    const server = await startServer(app);
    try {
      await withOutboundHttp(world.handler, async () => {
        const { response } = await postJson(server.baseUrl, '/api/ask', {
          question: 'The hospital missed my mother\'s cancer.',
          mode,
          sessionId: `sess-deadlines-${mode}`,
          history: [],
        });
        assert.equal(response.status, 200);
      });
      const system = world.calls.openai.find(call => call.kind === 'answer').request.messages[0].content;
      for (const phrase of present) assert.ok(system.includes(phrase), `the ${mode} prompt lacks: ${phrase}`);
      for (const phrase of absent) assert.ok(!system.includes(phrase), `the ${mode} prompt still says: ${phrase}`);
    } finally {
      await server.close();
    }
  }
});

test('the deadlines shown to visitors are stated correctly', () => {
  const page = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
  for (const name of ['index.html', 'script.js', 'disclaimer.html']) {
    const text = page(name);
    assert.doesNotMatch(text, /no limit|No SOL when a foreign object/i, `${name} still says a foreign-object claim has no deadline`);
    assert.match(text, /foreign object[^<]{0,40}1 year|within 1 year of its discovery/i, `${name} does not give the foreign-object deadline`);
    assert.match(text, /Lavern/, `${name} does not mention Lavern's Law`);
    assert.match(text, /notice of claim within 90 days/, `${name} does not mention the public-hospital notice of claim`);
  }
  assert.match(page('disclaimer.html'), /never beyond 10 years after the malpractice/);
});

// ─── Privacy policy ───────────────────────────────────────────────────────────

test('the privacy policy describes the analytics and outside services the pages use', () => {
  const page = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
  const policy = page('privacy.html').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // Only these two pages load Mixpanel, with the settings the policy was written against.
  const files = readdirSync(new URL('../public/', import.meta.url)).filter(name => /\.(html|js)$/.test(name));
  const pagesWithAnalytics = files.filter(name => page(name).includes('mixpanel.init(')).sort();
  assert.deepEqual(pagesWithAnalytics, ['index.html', 'register.html'], 'the policy names the pages that load Mixpanel; update it if this list changes');
  for (const name of pagesWithAnalytics) {
    assert.match(page(name), /mixpanel\.init\('[^']+', \{ track_pageview: true, persistence: 'localStorage' \}\)/, `${name} changed its Mixpanel settings`);
  }
  // Nothing ties the analytics to a person: no identify, people, alias or super-property calls.
  for (const name of files) {
    assert.doesNotMatch(page(name), /mixpanel\.(identify|people|alias|register(_once)?)\b/, `${name} sends Mixpanel more than the policy describes`);
  }
  // Every event property a page sends is one the policy describes.
  const sent = ['script.js', 'register.html']
    .flatMap(name => [...page(name).matchAll(/track\('([a-z_]+)',\s*\{([^}]*)\}/g)])
    .flatMap(([, , props]) => [...props.matchAll(/([a-z_]+):/g)].map(([, key]) => key));
  assert.deepEqual([...new Set(sent)].sort(), ['app', 'mode', 'score', 'turn_number', 'verdict'], 'a page reports something to Mixpanel that the policy does not describe');
  for (const phrase of ['We use Mixpanel to measure how the site is used', 'the mode you are in', 'the number of the message', 'claim-strength rating and score']) {
    assert.ok(policy.includes(phrase), `the policy no longer says: ${phrase}`);
  }
  assert.match(policy, /We do not send Mixpanel the text of your conversation, your name, or your phone number/);

  // Every outside host a page loads a script, stylesheet or font from is named in the policy.
  const namedAs = { 'fonts.googleapis.com': 'Google Fonts', 'fonts.gstatic.com': 'Google Fonts' };
  const loadedHosts = new Set(files.filter(name => name.endsWith('.html')).flatMap(name =>
    [...page(name).matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="https?:\/\/([^/"]+)/g)].map(([, host]) => host)));
  assert.ok(loadedHosts.size > 0);
  for (const host of loadedHosts) {
    assert.ok(namedAs[host] && policy.includes(namedAs[host]), `pages load ${host}, which the privacy policy does not name`);
  }

  // The statements the code contradicted are gone.
  assert.doesNotMatch(policy, /We use a single session cookie/);
  assert.doesNotMatch(policy, /No personal data is sent to CourtListener/);
  assert.match(policy, /our server sends CourtListener a few search keywords based on your conversation/);
});

// ─── Conversation steps ───────────────────────────────────────────────────────

test('each visitor message gets the next step of the conversation script', async () => {
  // The history holds the AI's replies too, so the step is the number of the visitor's message.
  const steps = [
    [0, 'TURN 1:'],
    [1, 'TURN 2:'],
    [2, 'TURN 3:'],
    [3, 'TURN 4:'],
    [4, 'TURN 5: If they want to speak with a qualified NYC malpractice attorney'],
  ];
  for (const [earlier, expected] of steps) {
    clearSearchCache();
    const world = fakeWorld();
    const history = Array.from({ length: earlier }, (_, i) => [
      { role: 'user', content: `Visitor message ${i + 1}.` },
      { role: 'assistant', content: `Reply ${i + 1}.` },
    ]).flat();
    const server = await startServer(app);
    let contactForm;
    try {
      await withOutboundHttp(world.handler, async () => {
        const { response, body } = await postJson(server.baseUrl, '/api/ask', {
          question: `Visitor message ${earlier + 1}.`,
          mode: 'personal',
          sessionId: `sess-step-${earlier + 1}`,
          history,
        });
        assert.equal(response.status, 200);
        contactForm = body.contactForm;
      });
      const system = world.calls.openai.find(call => call.kind === 'answer').request.messages[0].content;
      assert.ok(system.includes(expected), `visitor message ${earlier + 1} did not get ${expected}`);
      // Lead scoring starts with the second message; the case analysis comes with the assessment step.
      assert.equal(world.calls.openai.some(call => call.kind === 'scoreLead'), earlier + 1 >= 2, `lead scoring on visitor message ${earlier + 1}`);
      assert.equal(world.calls.openai.some(call => call.kind === 'caseAnalysis'), earlier + 1 >= 3, `case analysis on visitor message ${earlier + 1}`);
      // The contact form is offered from the referral step, and the AI points to it instead of asking for a number.
      assert.equal(contactForm, earlier + 1 >= 4, `contact form on visitor message ${earlier + 1}`);
      assert.equal(system.includes('contact form below this reply'), earlier + 1 >= 4, `form mentioned on visitor message ${earlier + 1}`);
      assert.ok(!system.includes('Ask for their name, phone number'), `visitor message ${earlier + 1} is asked to type contact details`);
    } finally {
      await server.close();
    }
  }
});

// ─── Blog ─────────────────────────────────────────────────────────────────────

test('the blog serves only New York medical malpractice articles, under the site name', async () => {
  const posts = getBlogPosts();
  assert.deepEqual(posts.map(post => post.slug).sort(), [
    'how-long-medical-malpractice-case-nyc',
    'what-is-medical-malpractice-new-york-state',
  ]);
  for (const { slug } of posts) {
    const post = getBlogPost(slug);
    const text = `${post.title} ${post.description} ${post.html}`;
    assert.doesNotMatch(text, /Louisiana|Baton Rouge|New Orleans|car accident|construction accident|slip and fall/i, `${slug} is off topic`);
    assert.doesNotMatch(text, /LegalisLaw|legalislaw-hub\.com|\[APP_URL\]/, `${slug} carries another site's byline, a dead link or a placeholder`);
    assert.equal(post.author, 'NYCMalpractice.ai Editorial');
  }

  const server = await startServer(blogApp);
  try {
    const index = await (await fetch(`${server.baseUrl}/blog`)).text();
    assert.match(index, /<title>Legal Blog &#8212; NYCMalpractice\.ai<\/title>/);
    assert.ok(index.includes(`<link rel="canonical" href="${process.env.APP_URL}/blog">`), 'the blog index names another site as its canonical address');
    assert.doesNotMatch(index, /legalislaw/i);
    for (const { slug } of posts) {
      const page = await (await fetch(`${server.baseUrl}/blog/${slug}`)).text();
      assert.ok(page.includes(`${process.env.APP_URL}/blog/${slug}`), `${slug} names another site as its canonical address`);
      assert.doesNotMatch(page, /legalislaw/i);
    }
  } finally {
    await server.close();
  }
});

test('the blog articles state the New York malpractice rules correctly', () => {
  const plain = slug => getBlogPost(slug).html.replace(/<[^>]+>/g, ' ').replace(/&#39;|&#x27;|&rsquo;/g, "'").replace(/\s+/g, ' ');

  const basics = plain('what-is-medical-malpractice-new-york-state');
  // There is no general discovery rule and no general five-year limit in New York malpractice law.
  assert.doesNotMatch(basics, /discovered \(or should have discovered\) the injury, whichever is later/);
  assert.doesNotMatch(basics, /absolute deadline is 5 years/);
  for (const phrase of ['2 years and 6 months', 'continuous treatment', "Lavern's Law", 'no later than 7 years', '1 year from when you discovered it', 'notice of claim within 90 days', 'within 2 years of the death', 'never beyond 10 years after the malpractice']) {
    assert.ok(basics.includes(phrase), `the article no longer says: ${phrase}`);
  }

  const timeline = plain('how-long-medical-malpractice-case-nyc');
  // The certificate of merit is the attorney's, after consulting a physician (CPLR 3012-a).
  assert.doesNotMatch(timeline, /certificate of merit from a qualified medical expert/);
  assert.match(timeline, /your attorney generally must file a certificate of merit/);
  assert.match(timeline, /consulted at least one physician/);
});

// ─── Slow case-law searches ───────────────────────────────────────────────────

test('a slow tailored search does not leave the reply without case law', async () => {
  clearSearchCache();
  const previous = process.env.COURTLISTENER_HEDGE_AFTER_MS;
  process.env.COURTLISTENER_HEDGE_AFTER_MS = '50';
  const requests = [];
  let slowFinished;
  const slowDone = new Promise(resolve => { slowFinished = resolve; });
  try {
    const cases = await withOutboundHttp(async url => {
      const q = new URL(url).searchParams.get('q');
      requests.push(q);
      if (q.includes('(')) {
        // The tailored query answers late.
        await new Promise(resolve => setTimeout(resolve, 400));
        slowFinished();
        return jsonResponse({ results: [{ ...CL_RESULT, caseName: 'Slow v. Tailored' }] });
      }
      return jsonResponse({ results: [CL_RESULT] });
    }, () => searchMalpracticeCases({ query: 'retained sponge', caseType: 'surgical_error' }));
    assert.equal(cases[0].caseName, 'Patient v. General Hospital', 'the reply waited for the slow tailored search');
    assert.deepEqual(requests, ['medical malpractice surgery (retained OR sponge)', 'medical malpractice surgery']);
    await slowDone;
  } finally {
    if (previous === undefined) delete process.env.COURTLISTENER_HEDGE_AFTER_MS;
    else process.env.COURTLISTENER_HEDGE_AFTER_MS = previous;
  }
});

test('a tailored search that answers in time is used without a second request', async () => {
  clearSearchCache();
  const requests = [];
  const cases = await withOutboundHttp(async url => {
    requests.push(new URL(url).searchParams.get('q'));
    return jsonResponse({ results: [CL_RESULT] });
  }, () => searchMalpracticeCases({ query: 'retained sponge', caseType: 'surgical_error' }));
  assert.equal(cases.length, 1);
  assert.deepEqual(requests, ['medical malpractice surgery (retained OR sponge)']);
});

// ─── Firm accounts and abuse limits ───────────────────────────────────────────

const { resetRateLimits } = await import('../rate-limit.js');

/** A database that knows one firm (7), one valid registration token for it, and recent codes. */
function firmWorld({ recentCodes = { forFirm: 0, forPhone: 0, justSent: 0 }, currentCode = null } = {}) {
  const calls = [];
  const handler = async (url, init) => {
    if (!url.endsWith('/sql')) throw new Error(`Unexpected outbound request in test: ${url}`);
    const { query, params } = JSON.parse(init.body);
    const q = query.replace(/\s+/g, ' ').trim();
    calls.push({ query: q, params });
    if (/FROM firm_tokens/.test(q)) {
      return params.includes('good-token') ? rowsResponse([['firm_id', INT], ['name', TEXT]], [['7', 'Test Firm']]) : rowsResponse([], []);
    }
    if (/^SELECT id FROM firms WHERE email/.test(q)) return rowsResponse([['id', INT]], [['7']]);
    if (/^SELECT phone FROM firms WHERE id/.test(q)) return rowsResponse([['phone', TEXT]], [['+15551234567']]);
    if (/FROM phone_codes pc JOIN firms f/.test(q)) {
      return rowsResponse([['for_firm', INT], ['for_phone', INT], ['just_sent', INT]],
        [[String(recentCodes.forFirm), String(recentCodes.forPhone), String(recentCodes.justSent)]]);
    }
    if (/^SELECT id, code FROM phone_codes/.test(q)) {
      return currentCode ? rowsResponse([['id', INT], ['code', TEXT]], [['31', currentCode]]) : rowsResponse([], []);
    }
    return jsonResponse(EMPTY_ROWS);
  };
  return { calls, handler };
}

async function withoutTexts(fn) {
  // With no Twilio account configured the code is only logged, so no test sends a real text.
  const sid = process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_ACCOUNT_SID;
  try {
    return await fn();
  } finally {
    process.env.TWILIO_ACCOUNT_SID = sid;
  }
}

test('the registration steps need their registration token, and a registered email gets no way in', async () => {
  const world = firmWorld();
  const server = await startServer(app);
  const send = (path, payload, method = 'POST') => fetch(`${server.baseUrl}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }).then(async response => ({ status: response.status, body: await response.json() }));
  try {
    await withOutboundHttp(world.handler, async () => {
      // Someone who knows a registered firm's email gets neither its number's steps nor a token.
      const again = await send('/api/firms/register', { name: 'Other', email: 'firm@example.test', phone: '5550000000' });
      assert.equal(again.status, 409);
      assert.equal(again.body.registrationToken, undefined);
      assert.match(again.body.error, /already registered/);

      for (const [path, payload, method] of [
        ['/api/firms/verify-phone', { firmId: 7, code: '123456' }],
        ['/api/firms/resend-code', { firmId: 7 }],
        ['/api/firms/7/profile', { specializations: ['dental'] }, 'PUT'],
        ['/api/billing/checkout', { firmId: 7 }],
      ]) {
        for (const token of [undefined, 'wrong-token']) {
          const { status } = await send(path, { ...payload, token }, method);
          assert.equal(status, 401, `${path} without a valid token`);
        }
      }
      // A valid token for firm 7 does not open firm 8.
      assert.equal((await send('/api/firms/8/profile', { specializations: ['dental'], token: 'good-token' }, 'PUT')).status, 401);

      // With the token, the step goes ahead.
      const saved = await send('/api/firms/7/profile', { specializations: ['dental'], serviceArea: 'Brooklyn', contactName: 'Pat Lee', token: 'good-token' }, 'PUT');
      assert.equal(saved.status, 200);
      const update = world.calls.find(call => /^UPDATE firms SET specializations/.test(call.query));
      assert.ok(update.params.includes('Pat Lee'), 'the contact name was not saved with the profile');
    });
  } finally {
    await server.close();
  }
});

test('verification texts are limited per firm and per phone number, and only the newest code works', async () => {
  await withoutTexts(async () => {
    const { sendVerificationCode, verifyPhoneCode, VerificationLimitError } = await import('../firms.js');

    for (const recentCodes of [{ forFirm: 5, forPhone: 5, justSent: 0 }, { forFirm: 1, forPhone: 6, justSent: 0 }, { forFirm: 1, forPhone: 1, justSent: 1 }]) {
      const world = firmWorld({ recentCodes });
      await withOutboundHttp(world.handler, async () => {
        await assert.rejects(sendVerificationCode(7), VerificationLimitError, JSON.stringify(recentCodes));
      });
      assert.ok(!world.calls.some(call => /^INSERT INTO phone_codes/.test(call.query)), 'a code was sent over the limit');
    }

    const world = firmWorld();
    await withOutboundHttp(world.handler, () => sendVerificationCode(7));
    const invalidate = world.calls.findIndex(call => /^UPDATE phone_codes SET expires_at = NOW\(\) WHERE firm_id/.test(call.query));
    const insert = world.calls.findIndex(call => /^INSERT INTO phone_codes/.test(call.query));
    assert.ok(invalidate >= 0 && insert > invalidate, 'older codes were not retired before the new one');
    assert.match(String(world.calls[insert].params[1]), /^\d{6}$/);

    // A wrong guess counts against the code; the right one verifies the phone.
    const guessing = firmWorld({ currentCode: '424242' });
    await withOutboundHttp(guessing.handler, async () => {
      assert.equal(await verifyPhoneCode(7, '111111'), false);
      assert.equal(await verifyPhoneCode(7, '424242'), true);
    });
    assert.ok(guessing.calls.some(call => /SET attempts = COALESCE\(attempts, 0\) \+ 1/.test(call.query)), 'a wrong guess was not counted');
    assert.ok(guessing.calls.some(call => /^UPDATE firms SET phone_verified = TRUE/.test(call.query)));
  });

  // Over the limit, the resend endpoint answers 429 with the reason.
  const limited = firmWorld({ recentCodes: { forFirm: 5, forPhone: 5, justSent: 0 } });
  const server = await startServer(app);
  try {
    await withOutboundHttp(limited.handler, async () => {
      const { response, body } = await postJson(server.baseUrl, '/api/firms/resend-code', { firmId: 7, token: 'good-token' });
      assert.equal(response.status, 429);
      assert.match(body.error, /Too many codes/);
    });
  } finally {
    await server.close();
  }
});

test('one client cannot send unlimited chat messages', async () => {
  const previous = process.env.RATE_LIMITS_IN_TESTS;
  process.env.RATE_LIMITS_IN_TESTS = '1';
  resetRateLimits();
  const server = await startServer(app);
  try {
    // Empty messages are refused before any AI call, so the limit is reached without spending anything.
    for (let i = 0; i < 20; i += 1) {
      const response = await fetch(`${server.baseUrl}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 400);
    }
    const blocked = await fetch(`${server.baseUrl}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /wait a few minutes/);
  } finally {
    await server.close();
    resetRateLimits();
    if (previous === undefined) delete process.env.RATE_LIMITS_IN_TESTS;
    else process.env.RATE_LIMITS_IN_TESTS = previous;
  }
});

test('the admin and job routes are closed when their secret is not configured', async () => {
  const admin = process.env.ADMIN_SECRET;
  const cron = process.env.CRON_SECRET;
  delete process.env.ADMIN_SECRET;
  delete process.env.CRON_SECRET;
  const server = await startServer(app);
  try {
    assert.equal((await fetch(`${server.baseUrl}/api/admin/firms`)).status, 503);
    assert.equal((await fetch(`${server.baseUrl}/api/admin/firms`, { headers: { 'x-admin-secret': '' } })).status, 503);
    assert.equal((await fetch(`${server.baseUrl}/api/cron`)).status, 503);
    assert.equal((await fetch(`${server.baseUrl}/api/cron/close-auctions`, { headers: { authorization: 'Bearer ' } })).status, 503);
  } finally {
    await server.close();
    process.env.ADMIN_SECRET = admin;
    process.env.CRON_SECRET = cron;
  }
});

test('a firm that chose All Malpractice is offered every case type', async () => {
  const { getActiveFirms } = await import('../firms.js');
  const calls = [];
  await withOutboundHttp(async (url, init) => {
    calls.push(JSON.parse(init.body).query.replace(/\s+/g, ' '));
    return jsonResponse(EMPTY_ROWS);
  }, () => getActiveFirms('dental'));
  assert.match(calls[0], /'other' = ANY\(specializations\) OR \$1 = ANY\(specializations\)/);
});

// ─── Declines ─────────────────────────────────────────────────────────────────

test('declines count over a rolling 30 days, and a suspension is never lifted by a later decline', async () => {
  const { declineLead } = await import('../auction.js');
  const { recordDecline } = await import('../firms.js');
  const counts = [[1, 0], [3, 0]];   // before this decline, then after it
  const calls = [];
  const handler = async (url, init) => {
    const { query, params } = JSON.parse(init.body);
    const q = query.replace(/\s+/g, ' ').trim();
    calls.push({ query: q, params });
    if (/^SELECT \* FROM leads WHERE id/.test(q)) {
      return rowsResponse([['id', INT], ['firm_id', INT], ['auction_id', INT], ['status', TEXT], ['price_paid', 1700], ['stripe_charge_id', TEXT]],
        [['501', '7', '9', 'pending', '200.00', null]]);
    }
    if (/FROM leads WHERE firm_id = \$1 AND status = 'declined' AND declined_at > NOW\(\) - INTERVAL '30 days'/.test(q)) {
      const [auction, cold] = counts.length > 1 ? counts.shift() : counts[0];
      return rowsResponse([['auction', INT], ['cold', INT]], [[String(auction), String(cold)]]);
    }
    if (/^UPDATE leads SET status = 'declined', declined_at = NOW\(\) WHERE id = \$1 AND status = 'pending' RETURNING id/.test(q)) {
      return rowsResponse([['id', INT]], [['501']]);
    }
    return jsonResponse(EMPTY_ROWS);
  };

  // One auction decline earlier this month, so this is the second: a 25% refund.
  const result = await withOutboundHttp(handler, () => declineLead(501, 7));
  assert.deepEqual(result, { ok: true, refundAmount: 50 });
  const marked = calls.findIndex(call => /^UPDATE leads SET status = 'declined', declined_at = NOW\(\) WHERE id = \$1 AND status = 'pending'/.test(call.query));
  const refunded = calls.findIndex(call => /^UPDATE leads SET refund_amount/.test(call.query));
  assert.ok(marked >= 0, 'the decline was not dated');
  assert.ok(refunded > marked, 'the refund was recorded before the lead was claimed');
  // With three auction declines in 30 days the firm is suspended; the update keeps any earlier suspension.
  const firmUpdate = calls.find(call => /^UPDATE firms SET auction_decline_count/.test(call.query));
  assert.match(firmUpdate.query, /suspended_until = CASE WHEN \$3 THEN NOW\(\) \+ INTERVAL '30 days' ELSE suspended_until END/);
  assert.deepEqual(firmUpdate.params.slice(0, 3).map(String), ['3', '0', 'true']);

  // A cold decline never suspends, and leaves an existing suspension in place.
  const coldCalls = [];
  await withOutboundHttp(async (url, init) => {
    const { query, params } = JSON.parse(init.body);
    coldCalls.push({ query: query.replace(/\s+/g, ' ').trim(), params });
    if (/FROM leads WHERE firm_id/.test(query)) return rowsResponse([['auction', INT], ['cold', INT]], [['3', '1']]);
    return jsonResponse(EMPTY_ROWS);
  }, () => recordDecline(7, false));
  const coldUpdate = coldCalls.find(call => /^UPDATE firms SET auction_decline_count/.test(call.query));
  assert.equal(String(coldUpdate.params[2]), 'false');
});

test('a lead nobody answers within 3 days is declined automatically and dated', async () => {
  const calls = [];
  const handler = async (url, init) => {
    const { query, params } = JSON.parse(init.body);
    const q = query.replace(/\s+/g, ' ').trim();
    calls.push({ query: q, params });
    if (/^UPDATE leads SET status = 'declined', declined_at = NOW\(\) WHERE status = 'pending' AND accept_deadline < NOW\(\) RETURNING id, firm_id, auction_id/.test(q)) {
      return rowsResponse([['id', INT], ['firm_id', INT], ['auction_id', INT]], [['501', '7', null]]);
    }
    if (/FROM leads WHERE firm_id/.test(q)) return rowsResponse([['auction', INT], ['cold', INT]], [['0', '1']]);
    return jsonResponse(EMPTY_ROWS);
  };
  const server = await startServer(app);
  try {
    await withOutboundHttp(handler, async () => {
      const response = await fetch(`${server.baseUrl}/api/cron`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).declined, 1);
    });
  } finally {
    await server.close();
  }
  assert.ok(calls.some(call => /^UPDATE firms SET auction_decline_count/.test(call.query)), 'the automatic decline was not counted against the firm');
  assert.ok(!calls.some(call => /refund/i.test(call.query)), 'an unanswered lead was refunded');
});

test('the Terms state the decline rules the code applies, and the site describes its AI accurately', () => {
  const plain = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const terms = plain('terms.html');
  assert.match(terms, /Declines are counted over the preceding 30 days/);
  assert.match(terms, /declined automatically, counts as a decline, and is not refunded/);
  for (const name of ['about.html', 'disclaimer.html']) {
    const text = plain(name);
    assert.doesNotMatch(text, /GPT-4o|trained on New York|Every response is grounded/, `${name} overstates what the AI is`);
  }
});

test('a lead is answered once: a second decline or a late accept changes nothing and refunds nothing', async () => {
  const { declineLead, acceptLead } = await import('../auction.js');
  const calls = [];
  // The lead still reads as pending, but another request claims it first, so the conditional UPDATE finds no row.
  const handler = async (url, init) => {
    const { query, params } = JSON.parse(init.body);
    const q = query.replace(/\s+/g, ' ').trim();
    calls.push({ query: q, params });
    if (/^SELECT \* FROM leads WHERE id/.test(q)) {
      return rowsResponse([['id', INT], ['firm_id', INT], ['auction_id', INT], ['status', TEXT], ['price_paid', 1700], ['stripe_charge_id', TEXT]],
        [['501', '7', '9', 'pending', '200.00', 'pi_test']]);
    }
    if (/FROM leads WHERE firm_id/.test(q)) return rowsResponse([['auction', INT], ['cold', INT]], [['0', '0']]);
    return jsonResponse(EMPTY_ROWS);
  };
  await withOutboundHttp(handler, async () => {
    assert.deepEqual(await declineLead(501, 7), { ok: false, error: 'Lead already answered' });
    assert.deepEqual(await acceptLead(501, 7), { ok: false, error: 'Lead already answered' });
  });
  assert.ok(!calls.some(call => /refund_amount|UPDATE firms/.test(call.query)), 'a lead answered twice was refunded or counted twice');
  assert.ok(calls.some(call => /^UPDATE leads SET status = 'accepted' WHERE id = \$1 AND status = 'pending' RETURNING id/.test(call.query)));
});

// ─── Case law when CourtListener cannot be searched ───────────────────────────

test('found decisions are saved for the case type, without the visitor words, and used when a later search fails', async () => {
  const question = 'My name is Jane Roe. My radiologist missed a tumor in March.';
  // 1) A search that works saves what it found, under the case type only.
  clearSearchCache();
  const working = fakeWorld();
  const server = await startServer(app);
  try {
    await withOutboundHttp(working.handler, async () => {
      const { response } = await postJson(server.baseUrl, '/api/ask', { question, mode: 'personal', sessionId: 'sess-memory-1', history: [] });
      assert.equal(response.status, 200);
    });
    const saved = working.calls.sql.find(call => /^INSERT INTO search_cache \(case_type, cases, updated_at\)/.test(call.query));
    assert.ok(saved, 'the decisions found were not saved');
    assert.equal(saved.params[0], 'misdiagnosis');
    const stored = JSON.parse(saved.params[1]);
    assert.equal(stored[0].caseName, 'Patient v. General Hospital');
    for (const words of ['Jane', 'Roe', 'radiologist', 'tumor', 'delayed cancer diagnosis']) {
      assert.ok(!saved.params.some(param => String(param).includes(words)), `the saved row holds "${words}"`);
    }

    // 2) CourtListener throttles the token: the saved decisions are used, and the model is told what they are.
    clearSearchCache();
    const failing = fakeWorld();
    const handler = async (url, init) => {
      if (url.startsWith('https://www.courtlistener.com/')) return jsonResponse({ detail: 'Request was throttled.' }, 429);
      if (url.endsWith('/sql') && /^SELECT cases FROM search_cache WHERE case_type = \$1/.test(JSON.parse(init.body).query.replace(/\s+/g, ' ').trim())) {
        assert.equal(String(JSON.parse(init.body).params[1]), '30');
        return rowsResponse([['cases', JSONB]], [[saved.params[1]]]);
      }
      return failing.handler(url, init);
    };
    await withOutboundHttp(handler, async () => {
      const { response, body } = await postJson(server.baseUrl, '/api/ask', { question, mode: 'personal', sessionId: 'sess-memory-2', history: [] });
      assert.equal(response.status, 200);
      assert.equal(body.cases.length, 1);
      assert.equal(body.cases[0].caseName, 'Patient v. General Hospital');
    });
    const system = failing.calls.openai.find(call => call.kind === 'answer').request.messages[0].content;
    assert.ok(system.includes('were not matched to these facts'), 'the model was not told the cases are from an earlier search');
    assert.ok(system.includes('Case: Patient v. General Hospital'));
    assert.ok(!failing.calls.sql.some(call => /^INSERT INTO search_cache/.test(call.query)), 'remembered cases were saved again as new');
  } finally {
    await server.close();
  }
});

test('with no saved decisions and no search, the reply falls back to general principles', async () => {
  clearSearchCache();
  const world = fakeWorld();
  const handler = async (url, init) => {
    if (url.startsWith('https://www.courtlistener.com/')) return jsonResponse({ detail: 'Request was throttled.' }, 429);
    return world.handler(url, init);
  };
  const server = await startServer(app);
  try {
    await withOutboundHttp(handler, async () => {
      const { response, body } = await postJson(server.baseUrl, '/api/ask', { question: 'A surgeon left a sponge in me.', mode: 'personal', sessionId: 'sess-memory-3', history: [] });
      assert.equal(response.status, 200);
      assert.deepEqual(body.cases, []);
    });
    const system = world.calls.openai.find(call => call.kind === 'answer').request.messages[0].content;
    assert.ok(system.includes('No specific cases retrieved'));
  } finally {
    await server.close();
  }
});

// ─── Public hospital deadline ─────────────────────────────────────────────────

test("a public hospital in the visitor's words is recognised, and not one named only in a reply", async () => {
  const { mentionsPublicHospital } = await import('../deadlines.js');
  const said = content => [{ role: 'user', content }];
  for (const words of [
    'They misread my scan at Bellevue.', 'I gave birth at Kings County Hospital', 'jacobi ER sent me home', 'NYC Health + Hospitals/Elmhurst',
    'it was H+H Woodhull', 'a city hospital in the Bronx', 'the state-run clinic', 'SUNY Downstate did my surgery', 'Coney Island Hospital',
    'my mother was at Sea View nursing home', 'Lincoln Hospital in the Bronx',
  ]) {
    assert.ok(mentionsPublicHospital(said(words)), words);
  }
  for (const words of ['My doctor at Mount Sinai missed it.', 'I live downstate.', 'Dr. Carter operated on me', 'NYU Langone', 'a private clinic in Queens', 'Abraham Lincoln']) {
    assert.ok(!mentionsPublicHospital(said(words)), words);
  }
  // The replies name Bellevue as an example; that alone does not count.
  assert.ok(!mentionsPublicHospital([{ role: 'assistant', content: 'For example Bellevue, Kings County or Elmhurst.' }, { role: 'user', content: 'It was NYU.' }]));
});

test('POST /api/ask tells the page to show the public hospital deadline when the visitor names one', async () => {
  clearSearchCache();
  const server = await startServer(app);
  try {
    for (const [question, expected] of [['They missed my stroke at Bellevue.', 'public_hospital'], ['My dentist in Manhattan broke my jaw.', null]]) {
      const world = fakeWorld();
      await withOutboundHttp(world.handler, async () => {
        const { response, body } = await postJson(server.baseUrl, '/api/ask', { question, mode: 'personal', sessionId: 'sess-public-hospital', history: [] });
        assert.equal(response.status, 200);
        assert.equal(body.deadlineNotice, expected, question);
      });
    }
  } finally {
    await server.close();
  }
});

test("a restored conversation brings back the public hospital deadline, and not the visitor's name or phone number", async () => {
  const handler = async (url, init) => {
    const query = JSON.parse(init.body).query.replace(/\s+/g, ' ').trim();
    assert.doesNotMatch(query, /\bname\b|\bphone\b/, 'the conversation route read the contact details');
    return rowsResponse([['session_id', TEXT], ['mode', TEXT], ['case_type', TEXT], ['history', JSONB]],
      [['sess-restore', 'personal', 'birth_injury', JSON.stringify([{ role: 'user', content: 'I delivered at Woodhull.' }, { role: 'assistant', content: 'I am sorry.' }])]]);
  };
  const server = await startServer(app);
  try {
    await withOutboundHttp(handler, async () => {
      const response = await fetch(`${server.baseUrl}/api/conversations/sess-restore`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.deadlineNotice, 'public_hospital');
      assert.equal(body.history.length, 2);
      assert.ok(!('name' in body) && !('phone' in body));
    });
  } finally {
    await server.close();
  }
});
