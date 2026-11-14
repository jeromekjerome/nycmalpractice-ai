import { test, expect } from '@playwright/test';

const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function fillStepOne(page) {
  await page.locator('#firmName').fill('Roe & Partners');
  await page.locator('#firmEmail').fill('intake@roe.example');
  await page.locator('#firmPhone').fill('5551234567');
  await page.locator('#attorneyName').fill('Pat Lee, Esq.');
  await page.locator('#attorneyRegistration').fill('1234567');
  await page.locator('button[onclick="registerFirm()"]').click();
}

test('an email that is already registered can ask for a sign-in link right there', async ({ page }) => {
  let linkFor = null;
  await page.route('**/api/firms/register', route => route.fulfill({
    status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'This email is already registered. Use Firm Login to get a sign-in link by email.', signIn: true }),
  }));
  await page.route('**/api/firms/portal-link', async route => { linkFor = route.request().postDataJSON(); await route.fulfill(json({ ok: true })); });
  await page.goto('/register.html');
  await fillStepOne(page);
  await expect(page.locator('#step1Error')).toHaveText('This email is already registered. Use Firm Login to get a sign-in link by email.');
  await page.locator('#signInLinkBtn').click();
  await expect.poll(() => linkFor).toEqual({ email: 'intake@roe.example' });
  await expect(page.locator('#signInMsg')).toContainText('We emailed a sign-in link to intake@roe.example');
});

test('a cancelled checkout returns to the plan step, and a checkout that cannot start says why', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('malpractice_firm_id', '7');
    sessionStorage.setItem('malpractice_registration_token', 'reg-token');
  });
  let sent = null;
  await page.route('**/api/billing/checkout', async route => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'This registration session has expired. Use Firm Login to get a sign-in link by email.' }) });
  });
  await page.goto('/register.html?step=4&cancelled=1');
  await expect(page.locator('#step4')).toBeVisible();
  await expect(page.locator('#cancelNote')).toBeVisible();
  await page.locator('button[onclick="goCheckout()"]').click();
  await expect.poll(() => sent).toEqual({ firmId: '7', token: 'reg-token' });
  // It used to fail without a word.
  await expect(page.locator('#step4Error')).toContainText('registration session has expired');
  await expect(page.locator('#step4Error a[href="/portal.html"]')).toBeVisible();
});

test('a firm back from a cancelled checkout in another tab is offered a sign-in link', async ({ page }) => {
  await page.goto('/register.html?step=4&cancelled=1');
  await expect(page.locator('#step1')).toBeVisible();
  await expect(page.locator('#signInBox')).toBeVisible();
  await expect(page.locator('#signInMsg')).toContainText('we will email you a sign-in link');
});

test('a firm can change a wrong number at the code step', async ({ page }) => {
  let changed = null;
  await page.route('**/api/firms/register', route => route.fulfill(json({ firmId: 7, isNew: true, phoneVerified: false, registrationToken: 'reg-token', notice: 'We could not text a code to that number.' })));
  await page.route('**/api/firms/phone', async route => { changed = route.request().postDataJSON(); await route.fulfill(json({ ok: true, phone: '+12125550199' })); });
  await page.goto('/register.html');
  await fillStepOne(page);
  await expect(page.locator('#step2Error')).toHaveText('We could not text a code to that number.');
  await page.locator('#step2 .code-hint a', { hasText: 'Change it' }).click();
  await page.locator('#newPhone').fill('212 555 0199');
  await page.locator('#phoneBtn').click();
  await expect.poll(() => changed).toEqual({ firmId: 7, token: 'reg-token', phone: '212 555 0199' });
  await expect(page.locator('#step2 .reg-sub')).toHaveText('We sent a 6-digit code to +12125550199. Enter it below to continue.');
});

// ─── Finishing sign-up from the portal ────────────────────────────────────────

// The portal's data request (GET /api/portal?token=...), not its profile save.
const PORTAL_DATA = url => url.pathname === '/api/portal';
const portalFirm = (fields = {}) => ({ id: 7, name: 'Roe & Partners', email: 'intake@roe.example', phone: '+15551234567', phone_verified: false,
  subscription_active: false, subscription_status: null, stripe_customer_id: null, approved_at: null, specializations: [], ...fields });

test('the portal lets a firm that stopped part-way verify its phone and start its subscription', async ({ page }) => {
  const sent = {};
  let firm = portalFirm();
  await page.route(PORTAL_DATA, route => route.fulfill(json({ firm, leads: [] })));
  await page.route('**/api/firms/resend-code', async route => { sent.resend = route.request().postDataJSON(); await route.fulfill(json({ ok: true })); });
  await page.route('**/api/firms/verify-phone', async route => {
    sent.verify = route.request().postDataJSON();
    firm = portalFirm({ phone_verified: true });
    await route.fulfill(json({ ok: true }));
  });
  await page.route('**/api/billing/checkout', async route => { sent.checkout = route.request().postDataJSON(); await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'stop here' }) }); });

  await page.goto('/portal.html?token=portal-token');
  await expect(page.locator('#statStatus')).toHaveText('Phone not verified');
  await expect(page.locator('#phoneOnFile')).toHaveText('+15551234567');
  // Nothing to manage at Stripe yet.
  await expect(page.locator('#billingBtn')).toBeHidden();
  await page.locator('#sendCodeBtn').click();
  await expect.poll(() => sent.resend).toEqual({ firmId: 7, token: 'portal-token' });
  await page.locator('#codeInput').fill('123456');
  await page.locator('#verifyBtn').click();
  await expect.poll(() => sent.verify).toEqual({ firmId: 7, token: 'portal-token', code: '123456' });

  await expect(page.locator('#statStatus')).toHaveText('Not subscribed');
  await expect(page.locator('#phoneSetup')).toBeHidden();
  await page.locator('#subscribeBtn').click();
  await expect.poll(() => sent.checkout).toEqual({ firmId: 7, token: 'portal-token', from: 'portal' });
  await expect(page.locator('#portalMsg')).toHaveText('stop here');
});

test('the portal shows a declined card and a payment due, and opens again on return from Stripe', async ({ page }) => {
  const firm = portalFirm({ phone_verified: true, subscription_status: 'past_due', stripe_customer_id: 'cus_7', approved_at: '2026-11-01T00:00:00Z', card_declined_at: '2026-11-10T15:00:00Z' });
  const asked = [];
  await page.route(PORTAL_DATA, route => { asked.push(new URL(route.request().url()).searchParams.get('token')); return route.fulfill(json({ firm, leads: [] })); });
  await page.goto('/portal.html?token=portal-token');
  await expect(page.locator('#statStatus')).toHaveText('Payment due');
  await expect(page.locator('#paymentDueNote')).toBeVisible();
  await expect(page.locator('#subscribeSetup')).toBeHidden();
  await expect(page.locator('#cardNotice')).toContainText('A lead charge to your card was declined on');
  await expect(page.locator('#billingBtn')).toBeVisible();
  // Stripe's billing page returns without the sign-in link; the visit still has it.
  await page.goto('/portal.html?billing=done');
  await expect(page.locator('#statStatus')).toHaveText('Payment due');
  expect(asked).toEqual(['portal-token', 'portal-token']);
});
