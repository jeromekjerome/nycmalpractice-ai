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

test('firm details an applicant typed are shown as text on the admin page, never run', async ({ page }) => {
  let sent = null;
  await page.route('**/api/admin/firms', route => route.fulfill(json({ firms: [HOSTILE], counts: { total: 1, active: 1 }, leadCounts: { total: 0 } })));
  await page.route('**/api/admin/firms/7/send-link', async route => { sent = route.request().url(); await route.fulfill(json({ ok: true })); });
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
