import { test, expect } from '@playwright/test';

const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

// A firm row whose fields were typed by an attacker during self-registration.
const HOSTILE = {
  id: 7,
  name: `x');window.__xss='name';//<img src=x onerror="window.__xss='img'">`,
  email: '<img src=x onerror="window.__xss=\'email\'">@evil.test',
  phone: '<b>555</b>',
  specializations: ['<img src=x onerror="window.__xss=\'spec\'">', 'dental'],
  service_area: '<i>Brooklyn</i>',
  contact_name: '<u>Pat</u>',
  attorney_name: '<img src=x onerror="window.__xss=\'attorney\'">',
  attorney_registration: '<b>1234567</b>',
  approved_at: null,
  active: true, phone_verified: true, subscription_active: true, created_at: '2026-11-13T10:00:00Z',
};

// The requests, auctions, leads and models sections, quiet unless a test fills them.
async function mockOperations(page, { requests = [], auctions = [], leads = [], models = { chains: { answer: [], small: [] }, source: 'defaults', override: null, providers: {}, measurements: [], registry: [] } } = {}) {
  const reasons = { unreachable: 'Could not reach the client (wrong or disconnected number)', conflict: 'Conflict of interest' };
  await page.route('**/api/admin/requests', route => route.fulfill(json({ requests, declineReasons: reasons })));
  await page.route('**/api/admin/auctions', route => route.fulfill(json({ auctions })));
  await page.route('**/api/admin/leads', route => route.fulfill(json({ leads, declineReasons: reasons })));
  await page.route('**/api/admin/models', route => route.fulfill(json(models)));
}

test('firm details an applicant typed are shown as text on the admin page, never run', async ({ page }) => {
  let sent = null;
  await page.route('**/api/admin/firms', route => route.fulfill(json({ firms: [HOSTILE], counts: { total: 1, active: 1 }, leadCounts: { total: 0 } })));
  await page.route('**/api/admin/firms/7/send-link', async route => { sent = route.request().url(); await route.fulfill(json({ ok: true })); });
  await mockOperations(page);
  page.on('dialog', dialog => dialog.dismiss());

  await page.goto('/admin.html');
  await page.locator('#secretInput').fill('secret');
  await page.locator('button.admin-btn').click();

  const table = page.locator('#firmsBody');
  await expect(table).toContainText("x');window.__xss='name';//");
  await expect(table).toContainText('<b>555</b>');
  await expect(table.locator('img, b, i, u')).toHaveCount(0);

  await table.getByRole('button', { name: 'Send Link' }).click();
  await expect.poll(() => sent).toContain('/api/admin/firms/7/send-link');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('the admin page approves a firm after its attorney registration is checked', async ({ page }) => {
  let patched = null;
  await page.route('**/api/admin/firms', route => route.fulfill(json({ firms: [{ ...HOSTILE, name: 'Roe & Partners', attorney_name: 'Pat Lee', attorney_registration: '1234567' }], counts: { total: 1, active: 1 }, leadCounts: { total: 0 } })));
  await page.route('**/api/admin/firms/7', async route => { patched = route.request().postDataJSON(); await route.fulfill(json({ ok: true })); });
  await mockOperations(page);
  page.on('dialog', dialog => dialog.dismiss());
  await page.goto('/admin.html');
  await page.locator('#secretInput').fill('secret');
  await page.locator('button.admin-btn').click();
  const table = page.locator('#firmsBody');
  await expect(table).toContainText('Awaiting approval');
  await expect(table).toContainText('NY reg. 1234567');
  await table.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => patched).toEqual({ approved: true });
});

test('the operator reads a contact request, delivers it by hand and cancels a stuck auction; what clients typed stays text', async ({ page }) => {
  const XSS = '<img src=x onerror="window.__xss=1">';
  const session = `sess-"'><img src=x onerror="window.__xss=2">`;
  const delivered = [];
  let cancelled = null;
  await page.route('**/api/admin/firms', route => route.fulfill(json({
    firms: [{ ...HOSTILE, id: 12, name: 'Roe & Partners', approved_at: '2026-11-01T00:00:00Z', leads_bought: 2, net_spend: '50.00', declines_30d: 1, subscription_status: 'past_due' }],
    counts: { total: 1, active: 1 }, leadCounts: { total: 2 },
  })));
  await mockOperations(page, {
    requests: [
      { session_id: session, case_type: 'misdiagnosis', mode: 'estate', name: XSS, phone: '5551234567', email: null, contact_consent_at: '2026-11-14T10:00:00Z', tier: 'hot', score: '84', leads: [], auctions: [{ id: 4, status: 'cancelled' }], unconfirmed_firms: [{ id: 12, name: 'Roe & Partners' }] },
      // Its auction is still closing: not delivered by hand meanwhile.
      { session_id: 'sess-running', case_type: 'dental', mode: 'personal', name: 'Sam Doe', phone: '5559876543', email: null, contact_consent_at: '2026-11-14T09:00:00Z', tier: 'hot', score: '81', leads: [], auctions: [{ id: 5, status: 'closing' }] },
    ],
    auctions: [{ id: 5, case_type: 'misdiagnosis', tier: 'hot', status: 'closing', bid_count: 0, current_bid: '200.00', closes_at: '2026-11-14T12:00:00Z' }],
    leads: [{ id: 41, firm_id: 12, firm_name: 'Roe & Partners', case_type: 'dental', tier: 'cold', price_paid: '25.00', status: 'declined', refund_amount: '25.00', decline_reason: 'unreachable', created_at: '2026-11-13T10:00:00Z' }],
  });
  await page.route(url => url.pathname.startsWith('/api/admin/requests/') && !url.pathname.endsWith('/deliver'), route => route.fulfill(json({
    request: { session_id: session, name: 'Jane Roe', phone: '5551234567', contact_consent_at: '2026-11-14T10:00:00Z', history: [{ role: 'user', content: XSS + ' My mother was misdiagnosed.' }] },
  })));
  await page.route(url => url.pathname.endsWith('/deliver'), async route => { delivered.push({ url: route.request().url(), body: route.request().postDataJSON() }); await route.fulfill(json({ ok: true, leadId: 900, emailed: true, firmId: 31, firmName: 'Pat & Sons' })); });
  await page.route('**/api/admin/auctions/5/cancel', async route => { cancelled = route.request().method(); await route.fulfill(json({ ok: true })); });
  page.on('dialog', dialog => dialog.accept());

  await page.goto('/admin.html');
  await page.locator('#secretInput').fill('secret');
  await page.locator('button.admin-btn').click();

  const requests = page.locator('#requestsBody');
  await expect(requests).toContainText(XSS);
  await expect(requests).toContainText('Auction #4: cancelled');
  const running = requests.locator('tr', { hasText: 'Sam Doe' });
  await expect(running).toContainText('Auction #5 is closing: cancel it below to deliver by hand.');
  await expect(running.getByRole('button', { name: 'Deliver to a firm…' })).toHaveCount(0);
  await expect(page.locator('#leadsBody')).toContainText('Could not reach the client');
  await expect(page.locator('#firmsBody')).toContainText('2 leads · $50.00 net');
  await expect(page.locator('#firmsBody')).toContainText('Stripe: past_due');

  const hostile = requests.locator('tr').first();
  await hostile.getByRole('button', { name: 'Conversation' }).click();
  await expect(page.locator('#transcriptBody')).toContainText(XSS + ' My mother was misdiagnosed.');
  await page.locator('#transcriptModal').getByRole('button', { name: 'Close' }).click();

  await hostile.getByRole('button', { name: 'Deliver to a firm…' }).click();
  await expect(hostile.locator('.deliver-form select')).toHaveCount(0);
  await hostile.locator('.deliver-form input').fill('40');
  await hostile.getByRole('button', { name: 'Deliver to a firm drawn at random' }).click();
  await expect.poll(() => delivered.length).toBe(1);
  expect(delivered[0].body).toEqual({ price: 40 });
  expect(decodeURIComponent(new URL(delivered[0].url).pathname)).toBe(`/api/admin/requests/${session}/deliver`);
  // A delivery reloads the tables; the next click waits for that.
  await expect(page.locator('#adminMsg')).toContainText('Lead #900 delivered to Pat & Sons');
  await page.waitForLoadState('networkidle');

  // A firm whose charge could not be confirmed is finished by name, at $0.
  await hostile.getByRole('button', { name: 'Deliver to a firm…' }).click();
  await hostile.locator('.deliver-form input').fill('40');
  await hostile.getByRole('button', { name: 'Finish delivery to Roe & Partners' }).click();
  await expect.poll(() => delivered.length).toBe(2);
  expect(delivered[1].body).toEqual({ firmId: 12, price: 0 });
  await page.waitForLoadState('networkidle');

  await page.locator('#auctionsBody').getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => cancelled).toBe('POST');
  await expect(page.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('the Models section shows the chains and refuses to save an unmeasured model without the override', async ({ page }) => {
  const XSS = '<img src=x onerror="window.__xss=3">';
  const models = {
    chains: { answer: ['gpt-6.1-terra', 'gpt-6-luna'], small: ['gpt-6-luna'] },
    source: 'settings',
    override: null,
    providers: { openai: 'up', anthropic: { downSince: '2026-11-21T15:00:00Z', reason: 'timeout' } },
    measurements: [
      { model: 'gpt-6.1-terra', role: 'answer', measuredOn: '2026-11-20', runLabel: 'reply-gpt-6.1-terra', qualityOk: true, barOk: true, failed: [] },
      { model: 'gpt-6-luna', role: 'small', measuredOn: '2026-11-20', runLabel: 'small-gpt-6-luna', qualityOk: true, barOk: false, failed: ['type', 'leadScore'] },
      { model: XSS, role: 'answer', measuredOn: '2026-11-20', runLabel: XSS, qualityOk: false, barOk: false, failed: ['speed', XSS] },
    ],
    registry: [
      { model: 'gpt-6.1-terra', provider: 'openai', hasKey: true, retiresOn: null },
      { model: 'gpt-6-luna', provider: 'openai', hasKey: true, retiresOn: null },
      { model: 'gpt-6.2-sol', provider: 'openai', hasKey: true, retiresOn: null },
      { model: 'claude-sonnet-5-5', provider: 'anthropic', hasKey: false, retiresOn: null },
    ],
  };
  const saves = [];
  await page.route('**/api/admin/firms', route => route.fulfill(json({ firms: [], counts: { total: 0, active: 0 }, leadCounts: { total: 0 } })));
  await mockOperations(page, { models });
  await page.route('**/api/admin/models/chains', async route => {
    const body = route.request().postDataJSON();
    saves.push(body);
    if (body.override) await route.fulfill(json({ ok: true, errors: [], warnings: ['Under the override, the reply chain names gpt-6.2-sol, which has no measurement on record as a reply model; the daily summary will say so until it has one.'] }));
    else await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ ok: false, errors: ['The reply chain names gpt-6.2-sol, which has no measurement on record as a reply model.'], warnings: [] }) });
  });
  await page.goto('/admin.html');
  await page.locator('#secretInput').fill('secret');
  await page.locator('button.admin-btn').click();

  // The two chains in order, each provider's state, and what each measurement says in plain words.
  const reply = page.locator('#chain-answer');
  await expect(reply.locator('select')).toHaveCount(2);
  await expect(reply.locator('select').first()).toHaveValue('gpt-6.1-terra');
  await expect(reply.locator('select').nth(1)).toHaveValue('gpt-6-luna');
  await expect(page.locator('#chain-small select')).toHaveValue('gpt-6-luna');
  await expect(page.locator('#modelsProviders')).toContainText('openai: up');
  await expect(page.locator('#modelsProviders')).toContainText('anthropic: down since');
  const measured = page.locator('#modelsMeasurements');
  await expect(measured.locator('tr', { hasText: 'reply-gpt-6.1-terra' })).toContainText('meets the bar');
  await expect(measured.locator('tr', { hasText: 'small-gpt-6-luna' })).toContainText("misses: agrees with today's model on the case type");
  await expect(measured.locator('tr', { hasText: 'small-gpt-6-luna' })).toContainText('moves the average lead score by more than 3 points');
  await expect(measured).toContainText(XSS);
  await expect(page.locator('#modelsSection img')).toHaveCount(0);

  // Put an unmeasured model first: the site refuses, and its words are shown.
  await reply.locator('select').first().selectOption('gpt-6.2-sol');
  await page.locator('#modelsSave').click();
  await expect(page.locator('#modelsResult')).toContainText('The reply chain names gpt-6.2-sol, which has no measurement on record as a reply model.');
  expect(saves).toEqual([{ answer: ['gpt-6.2-sol', 'gpt-6-luna'], small: ['gpt-6-luna'], override: false }]);

  // Reorder, then tick the override: it is sent, and its warning is shown.
  await reply.getByRole('button', { name: 'Down' }).first().click();
  await expect(reply.locator('select').first()).toHaveValue('gpt-6-luna');
  await page.getByLabel('use anyway, not measured').check();
  await page.locator('#modelsSave').click();
  await expect(page.locator('#modelsResult')).toContainText('The chains were saved.');
  await expect(page.locator('#modelsResult')).toContainText('Under the override, the reply chain names gpt-6.2-sol');
  expect(saves.at(-1)).toEqual({ answer: ['gpt-6-luna', 'gpt-6.2-sol'], small: ['gpt-6-luna'], override: true });
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});
