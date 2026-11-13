import { test, expect } from '@playwright/test';

const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function mockBasics(page) {
  await page.route('**/api/conversations/**', route => route.fulfill(json({ history: [] })));
  await page.route('**/api/reset-session', route => route.fulfill(json({ ok: true })));
  await page.route('**/api/case-types', route => route.fulfill(json({ caseTypes: ['Surgical Error'] })));
}

test('the contact form appears from the referral step, needs consent, and sends the details', async ({ page }) => {
  await mockBasics(page);
  let replies = 0;
  await page.route('**/api/ask', async route => {
    replies += 1;
    const referral = replies >= 2;
    await route.fulfill(json({
      answer: referral ? 'Would you like to speak with an attorney? You can use the contact form below this reply.' : 'When did this happen?',
      cases: [],
      contactForm: referral,
    }));
  });
  let contactRequest = null;
  await page.route('**/api/contact', async route => {
    contactRequest = route.request().postDataJSON();
    await route.fulfill(json({ ok: true }));
  });

  await page.goto('/');
  await page.locator('#userInput').fill('A surgeon left a sponge inside me.');
  await page.locator('#submitBtn').click();
  await expect(page.locator('#conversation .msg-ai').last()).toContainText('When did this happen?');
  await expect(page.locator('#conversation .contact-card')).toHaveCount(0);

  await page.locator('#userInput').fill('In March. Yes, I want to talk to a lawyer.');
  await page.locator('#submitBtn').click();
  const form = page.locator('#conversation .contact-card');
  await expect(form).toBeVisible();
  await expect(form).toContainText('one or more licensed New York attorneys');

  // Without the consent box, nothing is sent.
  await form.locator('input[name=name]').fill('Jane Roe');
  await form.locator('input[name=phone]').fill('(555) 123-4567');
  await form.locator('.contact-submit').click();
  await expect(form.locator('.contact-error')).toHaveText('Please check the box to agree to be contacted.');
  expect(contactRequest).toBeNull();

  await form.locator('input[name=bestTime]').fill('mornings');
  await form.locator('input[name=consent]').check();
  await form.locator('.contact-submit').click();
  await expect(page.locator('#conversation .contact-done')).toContainText('Your request has been received');
  await expect(page.locator('#conversation .contact-card')).toHaveCount(0);
  expect(contactRequest).toMatchObject({ name: 'Jane Roe', phone: '(555) 123-4567', bestTime: 'mornings', consent: true });
  expect(typeof contactRequest.sessionId).toBe('string');
});

test('a message the visitor types is shown as text, not run as HTML', async ({ page }) => {
  await mockBasics(page);
  await page.route('**/api/ask', route => route.fulfill(json({ answer: 'Thank you.', cases: [] })));
  await page.goto('/');
  await page.locator('#userInput').fill('<img src=x onerror="window.__typed=1">');
  await page.locator('#submitBtn').click();
  await expect(page.locator('#conversation .msg-user').last()).toHaveText('<img src=x onerror="window.__typed=1">');
  await expect(page.locator('#conversation .msg-user img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__typed)).toBeUndefined();
});

const LEAD = {
  id: 501, status: 'pending', caseType: 'misdiagnosis', tier: 'hot', pricePaid: 250, acceptDeadline: '2030-01-01T00:00:00Z', daysLeft: 3,
  leadData: {
    mode: 'personal',
    preview: 'Delayed cancer diagnosis after a misread scan.',
    dimensions: { injury_severity: 8, causation_clarity: 7, sol_status: 9, expert_viability: 7, damages_magnitude: 8 },
    history: [
      { role: 'user', content: 'My scan was misread. <img src=x onerror="window.__xss=1">' },
      { role: 'assistant', content: 'I am so sorry. When did you learn about it?' },
    ],
    contact: { name: 'Jane Roe', phone: '5551234567', bestTime: 'mornings', consentedAt: '2026-11-14T10:00:00.000Z' },
  },
  declinePolicy: { refundPct: 50, message: '50% refund' },
};

test('the lead page shows the contact details and the conversation, and accepts the lead', async ({ page }) => {
  await page.route(url => url.pathname === '/api/leads/501', route => route.fulfill(json(LEAD)));
  let accepted = null;
  await page.route(url => url.pathname === '/api/leads/501/accept', async route => {
    accepted = route.request().postDataJSON();
    await route.fulfill(json({ ok: true }));
  });

  await page.goto('/lead.html?id=501&token=abc');
  await expect(page.locator('#contactName')).toHaveText('Jane Roe');
  await expect(page.locator('#contactPhone a')).toHaveText('(555) 123-4567');
  await expect(page.locator('#contactPhone a')).toHaveAttribute('href', 'tel:+15551234567');
  await expect(page.locator('#contactTime')).toHaveText('mornings');
  await expect(page.locator('#consentNote')).toContainText('agreed to be contacted');
  await expect(page.locator('#preview')).toHaveText('Delayed cancer diagnosis after a misread scan.');
  // The client's own words are shown as text.
  await expect(page.locator('#transcript')).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(page.locator('#transcript img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  await page.locator('#acceptButton').click();
  await expect(page.locator('#actionMessage')).toContainText('Lead accepted');
  expect(accepted).toEqual({ token: 'abc' });
});

test('declining a lead shows the refund policy before it is sent', async ({ page }) => {
  await page.route(url => url.pathname === '/api/leads/501', route => route.fulfill(json(LEAD)));
  let declined = null;
  await page.route(url => url.pathname === '/api/leads/501/decline', async route => {
    declined = route.request().postDataJSON();
    await route.fulfill(json({ ok: true, refundAmount: 125 }));
  });

  await page.goto('/lead.html?id=501&token=abc');
  await page.locator('#declineButton').click();
  await expect(page.locator('#declineConfirm')).toContainText('50% refund');
  expect(declined).toBeNull();
  await page.locator('#confirmDecline').click();
  await expect(page.locator('#actionMessage')).toContainText('Refund: $125.00');
  expect(declined).toEqual({ token: 'abc' });
});

test('the auction page shows the case summary without contact details and places a bid', async ({ page }) => {
  const auction = {
    id: 9, status: 'open', tier: 'hot', caseType: 'misdiagnosis', qualityScore: 84,
    preview: 'Delayed cancer diagnosis after a misread scan.', currentBid: 200, secsLeft: 3600,
    dimensions: { injury_severity: 8, causation_clarity: 7, sol_status: 9, expert_viability: 7, damages_magnitude: 8 },
    recentBids: [{ amount: 200, time: '2026-11-14T10:00:00Z' }], isLeading: false,
    tierConfig: { label: 'Hot', color: '#7a2040' }, firmName: 'Test Firm',
  };
  await page.route(url => url.pathname === '/api/auctions/9', route => route.fulfill(json(auction)));
  let bid = null;
  await page.route(url => url.pathname === '/api/auctions/9/bid', async route => {
    bid = route.request().postDataJSON();
    await route.fulfill(json({ ok: true, currentBid: 250 }));
  });

  await page.goto('/auction.html?id=9&token=t1');
  await expect(page.locator('#firmLabel')).toHaveText('Test Firm');
  await expect(page.locator('#tierBadge')).toHaveText('Hot lead');
  await expect(page.locator('#pageTitle')).toContainText('Failure to Diagnose');
  await expect(page.locator('#preview')).toHaveText('Delayed cancer diagnosis after a misread scan.');
  await expect(page.locator('#minBid')).toHaveText('$201.00');
  await expect(page.locator('#dimensions .dim')).toHaveCount(5);

  await page.locator('#bidAmount').fill('250');
  await page.locator('#bidButton').click();
  await expect(page.locator('#bidMessage')).toContainText('Bid of $250.00 placed');
  expect(bid).toEqual({ token: 't1', amount: 250 });
});
