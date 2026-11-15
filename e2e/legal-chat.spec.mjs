import { test, expect } from '@playwright/test';

async function mockSession(page) {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
  await page.route(/^https?:\/\/([a-z0-9-]+\.)*(mxpnl|mixpanel)\.com\//, route => route.abort());
  await page.route('**/api/conversations/**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ history: [] }),
    });
  });

  await page.route('**/api/reset-session', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
}

async function mockCaseTypes(page) {
  await page.route('**/api/case-types', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ caseTypes: ['Failure to Diagnose', 'Surgical Error', 'Birth Injury'] }),
    });
  });
}

test('personal mode renders case guidance and supporting cards', async ({ page }) => {
  await mockSession(page);
  await mockCaseTypes(page);

  let askPayload;
  await page.route('**/api/ask', async route => {
    askPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        answer: '### Preliminary View\nThe timeline and provider records will matter.',
        cases: [
          {
            caseName: 'Patient v. Hospital',
            court: 'Supreme Court',
            dateFiled: '2025-03-01',
            citation: '100 A.D.3d 1',
            snippet: 'Delayed diagnosis increased harm.',
          },
        ],
        caseAnalysis: {
          score: 7,
          verdict: 'strong',
          complexityEstimate: {
            level: 'Moderate',
            reason: 'Experts will be needed.',
          },
          solWarning: 'The limitations period may be approaching.',
          strengths: ['Documented delay'],
          weaknesses: ['Need full chart review'],
        },
      }),
    });
  });

  await page.goto('/');
  await expect(page.locator('#caseTypesList li').first()).toHaveText('Failure to Diagnose');

  await page.locator('#userInput').fill('My doctor ignored repeated symptoms for months.');
  await page.locator('#userInput').press('Enter');

  await expect(page.locator('#conversation .msg-ai').last()).toContainText('timeline and provider records');
  await expect(page.locator('#casesList')).toContainText('Patient v. Hospital');
  await expect(page.locator('#analysisContent')).toContainText('limitations period may be approaching');
  expect(askPayload.mode).toBe('personal');
});

test('estate mode toggle changes the page state and request mode', async ({ page }) => {
  await mockSession(page);
  await mockCaseTypes(page);

  let askPayload;
  await page.route('**/api/ask', async route => {
    askPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        answer: 'The estate claim depends on the date of death and representative status.',
        cases: [],
      }),
    });
  });

  await page.goto('/');
  await page.locator('#modeToggle').evaluate(el => {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await expect(page.locator('body')).toHaveClass(/estate-mode/);
  await expect(page.locator('.quick-start-section')).toBeHidden();
  await page.locator('#userInput').fill('A family member died after delayed treatment.');
  await page.locator('#userInput').press('Enter');

  await expect(page.locator('#conversation .msg-ai').last()).toContainText('date of death');
  expect(askPayload.mode).toBe('estate');
});

test('server-side errors surface the generic AI fallback', async ({ page }) => {
  await mockSession(page);
  await mockCaseTypes(page);
  await page.route('**/api/ask', async route => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'boom' }),
    });
  });

  await page.goto('/');
  await page.locator('#userInput').fill('Was this malpractice?');
  await page.locator('#userInput').press('Enter');

  await expect(page.locator('#conversation')).toContainText('Sorry, something went wrong and your message was not answered.');
  // The question is not lost: it is back in the box, and the unanswered message is gone.
  await expect(page.locator('#userInput')).toHaveValue('Was this malpractice?');
  await expect(page.locator('#conversation .msg-user')).toHaveCount(0);
});



test('the landing page guides claimants and quick-starts a case', async ({ page }) => {
  await mockSession(page);
  await mockCaseTypes(page);
  await page.goto('/');

  await expect(page.locator('#claimantStart')).toHaveAttribute('href', '#userInput');
  await expect(page.locator('.trust-line')).toHaveText('Free · Nothing goes to a firm unless you ask.');
  await expect(page.locator('.how-it-works li')).toHaveCount(3);
  await expect(page.locator('.quick-start')).toHaveCount(6);

  await page.getByRole('button', { name: 'Surgical error', exact: true }).click();
  await expect(page.locator('#userInput')).toHaveValue(/surgeon/);
  await expect(page.locator('#userInput')).toBeFocused();
});

test('the contact form stays below the latest referral reply with entered details intact', async ({ page }) => {
  await mockSession(page);
  await mockCaseTypes(page);
  let replies = 0;
  await page.route('**/api/ask', async route => {
    replies += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ answer: `Reply ${replies}. The contact form is below this reply.`, cases: [], contactForm: replies >= 2 }),
    });
  });

  await page.goto('/');
  await page.locator('#userInput').fill('My symptoms were ignored.');
  await page.locator('#userInput').press('Enter');
  await expect(page.locator('#conversation .msg-ai')).toHaveCount(2);
  await page.locator('#userInput').fill('Yes, I want to talk to a lawyer.');
  await page.locator('#userInput').press('Enter');
  const form = page.locator('#conversation .contact-card');
  await expect(form).toBeVisible();
  await form.locator('input[name=name]').fill('Jane Roe');

  await page.locator('#userInput').fill('The delay lasted six months.');
  await page.locator('#userInput').press('Enter');
  await expect(page.locator('#conversation > :last-child')).toHaveClass(/contact-card/);
  await expect(form.locator('input[name=name]')).toHaveValue('Jane Roe');
  await expect(form).toBeInViewport({ ratio: 0.1 });
});

test('analytics records case conversion without contact details or conversation text', async ({ page }) => {
  await page.addInitScript(() => {
    window.__analytics = [];
    window.mixpanel = { __SV: 1, init() {}, track(name, params) { window.__analytics.push({ name, params }); } };
  });
  await mockSession(page);
  await mockCaseTypes(page);
  await page.route('**/api/ask', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      answer: 'You can ask for contact below this reply.', cases: [], caseType: 'misdiagnosis', leadTier: 'hot', contactForm: true,
      caseAnalysis: { score: 8, verdict: 'strong', strengths: [], weaknesses: [] },
    }),
  }));
  await page.route('**/api/contact', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, caseType: 'misdiagnosis', leadTier: 'hot' }),
  }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Failure to diagnose', exact: true }).click();
  await page.locator('#userInput').press('Enter');
  const form = page.locator('#conversation .contact-card');
  await form.locator('input[name=name]').fill('Jane Roe');
  await form.locator('input[name=phone]').fill('(555) 123-4567');
  await form.locator('input[name=email]').fill('jane@example.test');
  await form.locator('input[name=consent]').check();
  await form.locator('.contact-submit').click();
  await expect(page.locator('#conversation .contact-done')).toBeVisible();

  const events = await page.evaluate(() => window.__analytics);
  expect(events.find(event => event.name === 'quick_start_selected')?.params).toEqual({ app: 'malpractice-ai', case_type: 'misdiagnosis' });
  expect(events.find(event => event.name === 'case_analysis_viewed')?.params).toMatchObject({ case_type: 'misdiagnosis', lead_tier: 'hot' });
  expect(events.find(event => event.name === 'contact_form_submitted')?.params).toEqual({ app: 'malpractice-ai', case_type: 'misdiagnosis', lead_tier: 'hot' });
  expect(JSON.stringify(events)).not.toContain('Jane Roe');
  expect(JSON.stringify(events)).not.toContain('555');
  expect(JSON.stringify(events)).not.toContain('jane@example.test');
  expect(JSON.stringify(events)).not.toContain('diagnosed');
});

test('switching claimant modes restores both conversations without deleting either', async ({ page, baseURL }) => {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
  await page.route(/^https?:\/\/([a-z0-9-]+\.)*(mxpnl|mixpanel)\.com\//, route => route.abort());
  const saved = {
    'personal-with-contact': {
      mode: 'personal',
      history: [{ role: 'user', content: 'I was harmed and asked for a consultation.' }, { role: 'assistant', content: 'Your request was received.' }],
      contact_consent_at: '2026-11-14T10:00:00Z',
    },
    'estate-saved': {
      mode: 'estate',
      history: [{ role: 'user', content: 'My mother died after a delayed diagnosis.' }, { role: 'assistant', content: 'I am sorry for your loss.' }],
    },
  };
  await page.context().addCookies([
    { name: 'malpractice_session', value: 'personal-with-contact', url: baseURL },
    { name: 'malpractice_personal_session', value: 'personal-with-contact', url: baseURL },
    { name: 'malpractice_estate_session', value: 'estate-saved', url: baseURL },
  ]);
  await page.route('**/api/conversations/**', route => {
    const requested = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(saved[requested] || { history: [] }) });
  });
  let resetCalls = 0;
  await page.route('**/api/reset-session', route => {
    resetCalls += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await mockCaseTypes(page);

  await page.goto('/');
  await expect(page.locator('#conversation')).toContainText('I was harmed and asked for a consultation.');
  await page.locator('#modeToggle').evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(page.locator('#conversation')).toContainText('My mother died after a delayed diagnosis.');
  await expect(page.locator('body')).toHaveClass(/estate-mode/);
  await expect.poll(() => resetCalls).toBe(0);

  await page.locator('#modeToggle').evaluate(el => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(page.locator('#conversation')).toContainText('I was harmed and asked for a consultation.');
  await expect(page.locator('#conversation .contact-done')).toHaveCount(1);
  expect((await page.context().cookies()).find(cookie => cookie.name === 'malpractice_session')?.value).toBe('personal-with-contact');
  expect(resetCalls).toBe(0);
});


test('landing actions remain visible without horizontal overflow on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 860 });
  await mockSession(page);
  await mockCaseTypes(page);
  await page.goto('/');

  await expect(page.locator('.quick-start-section')).toBeInViewport({ ratio: 0.5 });
  const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(width.page).toBeLessThanOrEqual(width.viewport);
});


test('a returning visitor reopens the estate conversation they used last', async ({ page, baseURL }) => {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
  await page.route(/^https?:\/\/([a-z0-9-]+\.)*(mxpnl|mixpanel)\.com\//, route => route.abort());
  await page.context().addCookies([
    { name: 'malpractice_session', value: 'estate-return', url: baseURL },
    { name: 'malpractice_personal_session', value: 'personal-return', url: baseURL },
    { name: 'malpractice_estate_session', value: 'estate-return', url: baseURL },
  ]);
  await page.route('**/api/conversations/**', route => {
    const requested = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(requested === 'estate-return' ? {
        mode: 'estate',
        history: [{ role: 'user', content: 'My father died after a surgical error.' }, { role: 'assistant', content: 'I am sorry for your loss.' }],
      } : { history: [] }),
    });
  });
  await mockCaseTypes(page);

  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/estate-mode/);
  await expect(page.locator('#conversation')).toContainText('My father died after a surgical error.');
  await expect(page.locator('#modeToggle')).toBeChecked();
});
