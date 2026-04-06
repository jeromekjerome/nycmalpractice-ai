import { test, expect } from '@playwright/test';

async function mockSession(page) {
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

  await expect(page.locator('#conversation')).toContainText('I encountered an error. Please try again.');
});

