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

// The requests, auctions and leads sections, quiet unless a test fills them.
async function mockOperations(page, { requests = [], auctions = [], leads = [] } = {}) {
  const reasons = { unreachable: 'Could not reach the client (wrong or disconnected number)', conflict: 'Conflict of interest' };
  await page.route('**/api/admin/requests', route => route.fulfill(json({ requests, declineReasons: reasons })));
  await page.route('**/api/admin/auctions', route => route.fulfill(json({ auctions })));
  await page.route('**/api/admin/leads', route => route.fulfill(json({ leads, declineReasons: reasons })));
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
      { session_id: session, case_type: 'misdiagnosis', mode: 'estate', name: XSS, phone: '5551234567', email: null, contact_consent_at: '2026-11-14T10:00:00Z', tier: 'hot', score: '84', leads: [], auctions: [{ id: 4, status: 'cancelled' }] },
      // Its auction is still closing: not delivered by hand meanwhile.
      { session_id: 'sess-running', case_type: 'dental', mode: 'personal', name: 'Sam Doe', phone: '5559876543', email: null, contact_consent_at: '2026-11-14T09:00:00Z', tier: 'hot', score: '81', leads: [], auctions: [{ id: 5, status: 'closing' }] },
    ],
    auctions: [{ id: 5, case_type: 'misdiagnosis', tier: 'hot', status: 'closing', bid_count: 0, current_bid: '200.00', closes_at: '2026-11-14T12:00:00Z' }],
    leads: [{ id: 41, firm_id: 12, firm_name: 'Roe & Partners', case_type: 'dental', tier: 'cold', price_paid: '25.00', status: 'declined', refund_amount: '25.00', decline_reason: 'unreachable', created_at: '2026-11-13T10:00:00Z' }],
  });
  await page.route(url => url.pathname.startsWith('/api/admin/requests/') && !url.pathname.endsWith('/deliver'), route => route.fulfill(json({
    request: { session_id: session, name: 'Jane Roe', phone: '5551234567', contact_consent_at: '2026-11-14T10:00:00Z', history: [{ role: 'user', content: XSS + ' My mother was misdiagnosed.' }] },
  })));
  await page.route(url => url.pathname.endsWith('/deliver'), async route => { delivered.push({ url: route.request().url(), body: route.request().postDataJSON() }); await route.fulfill(json({ ok: true, leadId: 900, emailed: true })); });
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
  await hostile.locator('.deliver-form input').fill('40');
  await hostile.getByRole('button', { name: 'Deliver', exact: true }).click();
  await expect.poll(() => delivered.length).toBe(1);
  expect(delivered[0].body).toEqual({ firmId: 12, price: 40 });
  expect(decodeURIComponent(new URL(delivered[0].url).pathname)).toBe(`/api/admin/requests/${session}/deliver`);
  // A delivery reloads the tables; the next click waits for that.
  await expect(page.locator('#adminMsg')).toContainText('Lead #900 delivered');
  await page.waitForLoadState('networkidle');

  await page.locator('#auctionsBody').getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => cancelled).toBe('POST');
  await expect(page.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});
