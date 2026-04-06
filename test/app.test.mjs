import assert from 'node:assert/strict';

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

const { default: app } = await import('../server.js');

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