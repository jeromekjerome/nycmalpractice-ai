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
  // each card arrives whole: its heading with its content
  await expect(page.locator('#casesCard')).toBeVisible();
  await expect(page.locator('#casesCard .card-title')).toHaveText('Relevant NY Cases');
  await expect(page.locator('#casesList .case-item')).toHaveCount(1);
  await expect(page.locator('#analysisCard .card-title')).toHaveText('Case Analysis');
  await expect(page.locator('#summaryForm')).toBeVisible();
  expect(askPayload.mode).toBe('personal');
});

test('before a reply brings decisions there is no cases section, in the page as served or as shown', async ({ page }) => {
  await mockSession(page);
  await mockCaseTypes(page);
  await page.route('**/api/ask', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ answer: 'Thank you. When did the surgery take place?', cases: [] }),
  }));

  // As a reader gets it who runs no script and applies no style: no heading over an empty section.
  const served = await (await page.request.get('/')).text();
  expect(served).not.toContain('Relevant NY Cases');
  expect(served).not.toContain('Case Analysis');
  expect(served).not.toContain('Email my summary');

  // As a visitor sees it, before the first message...
  await page.goto('/');
  await expect(page.locator('#caseTypesList li').first()).toHaveText('Failure to Diagnose');
  await expect(page.locator('#casesCard')).toBeHidden();
  await expect(page.locator('#analysisCard')).toBeHidden();
  await expect(page.locator('body')).not.toContainText('Relevant NY Cases');

  // ...and after a reply that cites no decisions.
  await page.locator('#userInput').fill('I had surgery last year and something went wrong.');
  await page.locator('#userInput').press('Enter');
  await expect(page.locator('#conversation .msg-ai').last()).toContainText('When did the surgery take place?');
  await expect(page.locator('#casesCard')).toBeHidden();
  await expect(page.locator('body')).not.toContainText('Relevant NY Cases');
});

test('a visitor can email the assessment without putting the session in the return link', async ({ page }) => {
  await mockSession(page);
  await mockCaseTypes(page);
  await page.route('**/api/ask', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      answer: 'The delay may have caused additional harm.',
      cases: [],
      caseAnalysis: { score: 8, verdict: 'strong', strengths: ['Documented delay'], weaknesses: [] },
    }),
  }));
  let summaryRequest;
  await page.route('**/api/summary', async route => {
    summaryRequest = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/');
  await page.locator('#userInput').fill('My doctor ignored repeated symptoms for months.');
  await page.locator('#userInput').press('Enter');
  const form = page.locator('#summaryForm');
  await expect(form).toBeVisible();
  await form.locator('#summaryEmail').fill('jane@example.test');
  await form.locator('#summarySubmit').click();
  await expect(page.locator('#summaryStatus')).toHaveText('Summary sent. Check your inbox.');
  expect(summaryRequest.email).toBe('jane@example.test');
  expect(typeof summaryRequest.sessionId).toBe('string');
  expect(summaryRequest).not.toHaveProperty('returnUrl');
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

test('when every AI provider fails, the question goes back in the box and the deadline notice is shown', async ({ page }) => {
  await mockSession(page);
  await mockCaseTypes(page);
  await page.route('**/api/ask', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({
      error: 'The AI service is not answering just now, and your message was not answered. It is still in the box below: please send it again in a minute.',
      retry: true,
      deadlineNotices: ['public_hospital'],
    }),
  }));
  await page.goto('/');
  await page.locator('#userInput').fill('I had surgery at Bellevue.');
  await page.locator('#userInput').press('Enter');
  await expect(page.locator('#conversation .msg-notice')).toContainText('not answering just now');
  await expect(page.locator('#userInput')).toHaveValue('I had surgery at Bellevue.');
  await expect(page.locator('#conversation .msg-user')).toHaveCount(0);
  // The notice the visitor's own words call for is shown though no reply came, once however often they try again.
  const notices = page.locator('#conversation .deadline-notice');
  await expect(notices).toHaveCount(1);
  await expect(notices).toContainText('a written notice of the claim generally must be filed within 90 days');
  await page.locator('#userInput').press('Enter');
  await expect(page.locator('#conversation .msg-notice')).toHaveCount(2);
  await expect(notices).toHaveCount(1);
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


test('visitors can move from the home page to a guide and back into the assistant', async ({ page }) => {
  await mockSession(page);
  await mockCaseTypes(page);
  await page.goto('/');
  await page.locator('.site-footer').getByRole('link', { name: 'Legal Guides' }).click();
  await expect(page).toHaveURL(/\/blog$/);
  await expect(page.getByRole('heading', { name: 'Legal Insights' })).toBeVisible();
  await page.locator('.post-card > a').first().click();
  await expect(page.locator('.chat-cta')).toBeVisible();
  await page.locator('.chat-cta a').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#userInput')).toBeVisible();
});

test('a phone puts the assessment first, keeps the input compact, and makes contact text readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSession(page);
  await mockCaseTypes(page);
  await page.route('**/api/ask', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      answer: 'You can ask for contact below this reply.',
      cases: [],
      contactForm: true,
      caseAnalysis: { score: 8, verdict: 'strong', strengths: ['Documented delay'], weaknesses: [] },
    }),
  }));
  await page.goto('/');
  await page.locator('#userInput').fill('My doctor ignored repeated symptoms for months.');
  await page.locator('#userInput').press('Enter');
  await expect(page.locator('#analysisCard')).toBeVisible();
  await expect(page.locator('.contact-card')).toBeVisible();

  const assessmentFirst = await page.evaluate(() => {
    const assessment = document.getElementById('analysisCard');
    const chat = document.querySelector('.main-card');
    return assessment.getBoundingClientRect().top < chat.getBoundingClientRect().top;
  });
  expect(assessmentFirst).toBe(true);

  const input = await page.locator('.interaction-card').evaluate(el => ({
    height: el.getBoundingClientRect().height,
    position: getComputedStyle(el).position,
  }));
  expect(input.position).toBe('sticky');
  expect(input.height).toBeLessThanOrEqual(190);

  const contrast = await page.evaluate(() => {
    const parse = value => {
      const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number);
      return { r, g, b, a };
    };
    const luminance = color => {
      const channels = [color.r, color.g, color.b].map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const ratioFor = selector => {
      const el = document.querySelector(selector);
      const layers = [];
      for (let node = el; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color.a > 0) layers.push(color);
      }
      const background = layers.reverse().reduce((base, layer) => ({
        r: layer.r * layer.a + base.r * (1 - layer.a),
        g: layer.g * layer.a + base.g * (1 - layer.a),
        b: layer.b * layer.a + base.b * (1 - layer.a),
      }), { r: 0, g: 0, b: 0 });
      const foreground = parse(getComputedStyle(el).color);
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    };
    return { label: ratioFor('.contact-label'), consent: ratioFor('.contact-consent') };
  });
  expect(contrast.label).toBeGreaterThanOrEqual(4.5);
  expect(contrast.consent).toBeGreaterThanOrEqual(4.5);
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
