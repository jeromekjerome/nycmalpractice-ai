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
  await expect(form).toContainText('up to three licensed New York attorneys');

  // Without the consent box, nothing is sent.
  await form.locator('input[name=name]').fill('Jane Roe');
  await form.locator('input[name=phone]').fill('(555) 123-4567');
  await form.locator('.contact-submit').click();
  await expect(form.locator('.contact-error')).toHaveText('Please check the box to agree to be contacted.');
  expect(contactRequest).toBeNull();

  await form.locator('input[name=bestTime]').fill('mornings');
  await form.locator('input[name=email]').fill('jane@example.test');
  await form.locator('input[name=consent]').check();
  await form.locator('.contact-submit').click();
  await expect(page.locator('#conversation .contact-done')).toContainText('Your request has been received');
  await expect(page.locator('#conversation .contact-card')).toHaveCount(0);
  expect(contactRequest).toMatchObject({ name: 'Jane Roe', phone: '(555) 123-4567', email: 'jane@example.test', bestTime: 'mornings', consent: true });
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
    contact: { name: 'Jane Roe', phone: '5551234567', email: 'jane@example.test', bestTime: 'mornings', consentedAt: '2026-11-14T10:00:00.000Z', consentText: 'I agree to be contacted by phone.' },
    evaluation: {
      domain_id: 'nyc_malpractice_personal', gate_status: 'PASSED', evaluator: 'llm', first_pass_compliant: false, final_attempt_number: 2,
      initial_coaching: { gate_status: 'BLOCKED', summary: 'Attempt 1 was BLOCKED on PROH-MM-01 <b>bold</b>.' },
      citation_audit: [
        { citation_text: 'Patient v. General Hospital, 200 A.D.3d 100', status: 'ANCHORED', courtlistener_status: 'UNCHECKED', matched_case: 'Patient v. General Hospital', matched_case_url: 'javascript:alert(1)' },
      ],
      required_checks: [{ id: 'REQ-MM-03', name: 'Mandatory Non-Advice Disclaimer', passed: true, evidence_or_gap: 'Required phrase present' }],
      prohibited_checks: [{ id: 'PROH-MM-01', name: 'Unanchored Case Citations (Hallucination Gate)', violated: false, offending_quote: 'None' }],
      human_verification_checklist: ['Verify the filing deadline against the treatment dates', 'Confirm conflict-of-interest check', 'Confirm physician review', 'Shepardize or KeyCite every decision relied on; the automatic screen shown beside each decision is not a citator'],
    },
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
  await expect(page.locator('#contactEmail a')).toHaveAttribute('href', 'mailto:jane@example.test');
  await expect(page.locator('#consentNote')).toContainText('agreed to be contacted');
  await expect(page.locator('#consentNote')).toContainText('The wording they agreed to: “I agree to be contacted by phone.”');
  await expect(page.locator('#preview')).toHaveText('Delayed cancer diagnosis after a misread scan.');
  // The client's own words are shown as text.
  await expect(page.locator('#transcript')).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(page.locator('#transcript img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  // The gate's audit of the AI's last reply, with the first draft's problem shown, never run as HTML.
  const audit = page.locator('#gatekeeperCard');
  await expect(page.locator('#gateStatusBadge')).toHaveText('Gate status: PASSED');
  await expect(audit).toContainText('The first draft was blocked and rewritten (2 attempts)');
  await expect(audit).toContainText('Attempt 1 was BLOCKED on PROH-MM-01 <b>bold</b>.');
  await expect(audit.locator('.cite-row')).toContainText('ANCHORED');
  await expect(audit.locator('a')).toHaveCount(0);
  await expect(audit.locator('b')).toHaveCount(0);
  await expect(page.locator('#hitlSolHelp')).toHaveText('Verify the filing deadline against the treatment dates');

  await expect(page.locator('#hitlCitatorHelp')).toHaveText('Shepardize or KeyCite every decision relied on; the automatic screen shown beside each decision is not a citator');

  // Four checkboxes; the fourth carries the approved sentence. Accept stays locked until all four are confirmed.
  await expect(page.locator('.hitl-check')).toHaveCount(4);
  await expect(page.locator('label:has(#hitlCitator)')).toHaveText("Before relying on any decision, I will Shepardize or KeyCite it myself. Each decision shows whether and when it passed this site's automatic screen, which is not a citator.");
  await expect(page.locator('#hitlCitator')).not.toBeChecked();
  const accept = page.locator('#acceptButton');
  await expect(accept).toBeDisabled();
  await expect(accept).toHaveText('Complete the four checks to accept');
  await page.locator('#hitlSol').check();
  await page.locator('#hitlConflict').check();
  await page.locator('#hitlQuality').check();
  await expect(accept).toBeDisabled();
  await page.locator('#hitlCitator').check();
  await expect(accept).toBeEnabled();
  await page.locator('#hitlConflict').uncheck();
  await expect(accept).toBeDisabled();
  await page.locator('#hitlConflict').check();
  await accept.click();
  await expect(page.locator('#actionMessage')).toContainText('Lead accepted');
  expect(accepted).toEqual({ token: 'abc', hitlVerification: { sol_and_notice_verified: true, conflict_check_completed: true, case_quality_reviewed: true, decisions_citator_checked: true } });
});

// The lead with its stored audit replaced by these rows.
const leadWithAudit = citationAudit => ({ ...LEAD, leadData: { ...LEAD.leadData, evaluation: { ...LEAD.leadData.evaluation, citation_audit: citationAudit } } });

test('the lead page says Found in CourtListener and Not found in CourtListener, never the old wording', async ({ page }) => {
  await page.route(url => url.pathname === '/api/leads/501', route => route.fulfill(json(leadWithAudit([
    { citation_text: 'Patient v. General Hospital, 200 A.D.3d 100', status: 'UNANCHORED', courtlistener_status: 'VERIFIED', courtlistener_case_name: 'Patient v. General Hospital', courtlistener_url: 'https://www.courtlistener.com/opinion/1/patient-v-general-hospital/' },
    { citation_text: 'Smith v. FakeCorp, 999 N.Y.3d 111', status: 'UNANCHORED', courtlistener_status: 'NOT_FOUND_404', courtlistener_url: null },
  ]))));
  await page.goto('/lead.html?id=501&token=abc');
  const audit = page.locator('#citationAudit');
  const row = text => audit.locator('li', { hasText: text });
  await expect(row('Patient v. General Hospital').getByRole('link')).toHaveText('Found in CourtListener — Patient v. General Hospital');
  await expect(row('Patient v. General Hospital').getByRole('link')).toHaveAttribute('href', 'https://www.courtlistener.com/opinion/1/patient-v-general-hospital/');
  await expect(row('Smith v. FakeCorp')).toContainText('Not found in CourtListener');
  await expect(row('Smith v. FakeCorp').locator('a')).toHaveCount(0);
  await expect(audit).not.toContainText('CourtListener: VERIFIED');
  await expect(audit).not.toContainText('CourtListener: NOT FOUND');
});

test('each anchored decision on the lead page shows its screen label, and a hostile date stays text and reads Not screened', async ({ page }) => {
  const anchored = (name, id, screen) => ({
    citation_text: name, status: 'ANCHORED', courtlistener_status: 'UNCHECKED', matched_case: name,
    matched_case_url: `https://www.courtlistener.com/opinion/${id}/x/`, ...(screen ? { matched_case_screen: screen } : {}),
  });
  await page.route(url => url.pathname === '/api/leads/501', route => route.fulfill(json(leadWithAudit([
    anchored('Clear v. Case', 1, { state: 'clear', on: '2026-11-24' }),
    anchored('Held v. Case', 2, { state: 'held', on: null }),
    anchored('Plain v. Case', 3, { state: 'unscreened', on: null }),
    anchored('Hostile v. Case', 4, { state: 'clear', on: '<img src=x onerror="window.__screen=1">' }),
    anchored('Short v. Case', 5, { state: 'clear', on: '2026-11-4' }),
    anchored('Missing v. Case', 6, null),
    { citation_text: 'Smith v. FakeCorp, 999 N.Y.3d 111', status: 'UNANCHORED', courtlistener_status: 'NOT_FOUND_404', courtlistener_url: null },
  ]))));
  await page.goto('/lead.html?id=501&token=abc');

  const row = text => page.locator('#citationAudit li', { hasText: text });
  await expect(row('Clear v. Case').locator('.cite-screen')).toHaveText('Screened Nov 24, 2026');
  await expect(row('Held v. Case').locator('.cite-screen')).toHaveText('Held for review: later history found');
  await expect(row('Plain v. Case').locator('.cite-screen')).toHaveText('Not screened');
  await expect(row('Hostile v. Case').locator('.cite-screen')).toHaveText('Not screened');
  await expect(row('Short v. Case').locator('.cite-screen')).toHaveText('Not screened');
  // A row with no label from the server shows none, and the status chips are unchanged by the labels.
  await expect(row('Missing v. Case').locator('.cite-screen')).toHaveCount(0);
  await expect(row('Smith v. FakeCorp').locator('.cite-screen')).toHaveCount(0);
  await expect(page.locator('#citationAudit .cite-chip')).toHaveText(['ANCHORED', 'ANCHORED', 'ANCHORED', 'ANCHORED', 'ANCHORED', 'ANCHORED', 'UNANCHORED']);
  await expect(page.locator('#citationAudit img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__screen)).toBeUndefined();
  await expect(page.locator('#citationAudit')).not.toContainText('Shepardized');
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
  // A reason is required.
  await page.locator('#confirmDecline').click();
  await expect(page.locator('#actionMessage')).toContainText('Choose why you are declining this lead.');
  expect(declined).toBeNull();
  await page.locator('#declineReason').selectOption('outside_practice');
  await page.locator('#confirmDecline').click();
  await expect(page.locator('#actionMessage')).toContainText('Refund: $125.00');
  expect(declined).toEqual({ token: 'abc', reason: 'outside_practice' });
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
  await page.locator('#confirmBidBtn').click();   // the amount is confirmed before the bid is sent
  await expect(page.locator('#bidMessage')).toContainText('Bid of $250.00 placed');
  expect(bid).toEqual({ token: 't1', amount: 250 });
});

test('firm sign-up sends its registration token with every later step, and keeps the contact name', async ({ page }) => {
  const sent = {};
  await page.route('**/api/firms/register', async route => { sent.register = route.request().postDataJSON(); await route.fulfill(json({ firmId: 7, isNew: true, phoneVerified: false, registrationToken: 'reg-token' })); });
  await page.route('**/api/firms/verify-phone', async route => { sent.verify = route.request().postDataJSON(); await route.fulfill(json({ ok: true })); });
  await page.route('**/api/firms/7/profile', async route => { sent.profile = route.request().postDataJSON(); await route.fulfill(json({ ok: true })); });
  await page.route('**/api/billing/checkout', async route => { sent.checkout = route.request().postDataJSON(); await route.fulfill(json({ url: '/register.html?subscribed=1' })); });

  await page.goto('/register.html');
  await page.locator('#firmName').fill('Roe & Partners');
  await page.locator('#contactName').fill('Pat Lee');
  await page.locator('#firmEmail').fill('intake@roe.example');
  await page.locator('#firmPhone').fill('5551234567');
  await page.locator('#attorneyName').fill('Pat Lee, Esq.');
  await page.locator('#attorneyRegistration').fill('1234567');
  await page.locator('button[onclick="registerFirm()"]').click();
  // Nothing is sent until the firm agrees to the Terms.
  await expect(page.locator('#step1Error')).toHaveText('You must agree to the Terms of Service');
  expect(sent.register).toBeUndefined();
  await page.locator('#termsConsent').check();
  await page.locator('button[onclick="registerFirm()"]').click();
  await expect.poll(() => sent.register).toMatchObject({ attorneyName: 'Pat Lee, Esq.', attorneyRegistration: '1234567', termsAccepted: true });

  const digits = page.locator('.otp-digit');
  for (let i = 0; i < 6; i += 1) await digits.nth(i).fill(String(i + 1));
  await page.locator('button[onclick="verifyPhone()"]').click();
  expect(sent.verify).toEqual({ firmId: 7, code: '123456', token: 'reg-token' });

  await page.locator('.spec-item input[value="dental"]').check();
  await page.locator('#serviceArea').fill('Brooklyn');
  await page.locator('button[onclick="saveProfile()"]').click();
  await expect.poll(() => sent.profile).toBeTruthy();
  expect(sent.profile).toEqual({ specializations: ['dental'], serviceArea: 'Brooklyn', contactName: 'Pat Lee', token: 'reg-token' });

  await page.locator('button[onclick="goCheckout()"]').click();
  await expect.poll(() => sent.checkout).toEqual({ firmId: 7, token: 'reg-token' });
});

test('naming a public hospital shows its 90-day deadline once, in the words for the current mode', async ({ page }) => {
  await mockBasics(page);
  await page.route('**/api/ask', route => route.fulfill(json({ answer: 'I am so sorry. When did this happen?', cases: [], deadlineNotice: 'public_hospital' })));
  await page.goto('/');
  await page.locator('#userInput').fill('They missed my stroke at Bellevue.');
  await page.locator('#submitBtn').click();
  const notice = page.locator('#conversation .deadline-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('within 90 days of the malpractice');
  await expect(notice).not.toContainText('wrongful-death');

  await page.locator('#userInput').fill('Last month.');
  await page.locator('#submitBtn').click();
  await expect(page.locator('#conversation .msg-ai')).toHaveCount(3);
  await expect(notice).toHaveCount(1);

  // A family asking about a death gets the wrongful-death version.
  await page.locator('#modeToggle').evaluate(el => {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(notice).toHaveCount(0);
  await page.locator('#userInput').fill('My father died after surgery at Kings County Hospital.');
  await page.locator('#submitBtn').click();
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("after the estate's representative is appointed");
});

test('a lead with no audit on file says so, and its checks still gate Accept', async ({ page }) => {
  const { evaluation, ...leadData } = LEAD.leadData;
  await page.route(url => url.pathname === '/api/leads/501', route => route.fulfill(json({ ...LEAD, leadData })));
  await page.goto('/lead.html?id=501&token=abc');
  await expect(page.locator('#gateStatusBadge')).toHaveText('Gate status: NOT ON FILE');
  await expect(page.locator('#gateSummary')).toContainText('No compliance audit is stored');
  await expect(page.locator('#acceptButton')).toBeDisabled();
});

test('a federal provider shows its 2-year claim deadline, and a restored conversation brings it back', async ({ page, context, baseURL }) => {
  await page.route('**/api/reset-session', route => route.fulfill(json({ ok: true })));
  await page.route('**/api/case-types', route => route.fulfill(json({ caseTypes: ['Surgical Error'] })));
  let saved = { history: [] };
  await page.route('**/api/conversations/**', route => route.fulfill(json(saved)));
  await page.route('**/api/ask', route => route.fulfill(json({ answer: 'I am so sorry. When did this happen?', cases: [], deadlineNotices: ['public_hospital', 'federal'] })));
  await page.goto('/');
  await page.locator('#userInput').fill('Bellevue sent me to the VA clinic, and they missed it.');
  await page.locator('#submitBtn').click();
  const notices = page.locator('#conversation .deadline-notice');
  await expect(notices).toHaveCount(2);
  await expect(notices.nth(1)).toContainText('Standard Form 95, generally within 2 years');
  await expect(notices.nth(1)).not.toContainText('your loved one');

  // The visitor comes back later: the conversation and its deadline notice return.
  saved = { mode: 'personal', history: [{ role: 'user', content: 'The VA clinic missed it.' }, { role: 'assistant', content: 'When?' }], deadlineNotices: ['federal'] };
  await page.reload();
  await expect(page.locator('#conversation .msg-user')).toContainText('The VA clinic missed it.');
  await expect(notices).toHaveCount(1);
  await expect(notices).toContainText('Federal provider');
});

test('when the host cuts a slow reply off, the question goes back in the box', async ({ page }) => {
  await mockBasics(page);
  await page.route('**/api/ask', route => route.fulfill({ status: 504, contentType: 'text/html', body: '<html><body>FUNCTION_INVOCATION_TIMEOUT</body></html>' }));
  await page.goto('/');
  await page.locator('#userInput').fill('The surgeon left a sponge inside me.');
  await page.locator('#submitBtn').click();
  await expect(page.locator('#conversation .msg-notice')).toHaveText('Sorry, something went wrong and your message was not answered. It is back in the box below: please send it again.');
  await expect(page.locator('#conversation')).not.toContainText('FUNCTION_INVOCATION_TIMEOUT');
  await expect(page.locator('#userInput')).toHaveValue('The surgeon left a sponge inside me.');
  await expect(page.locator('#conversation .msg-user')).toHaveCount(0);
});

test('screen readers hear that the answer is on its way, and a reload brings back the contact form', async ({ page }) => {
  await page.route('**/api/reset-session', route => route.fulfill(json({ ok: true })));
  await page.route('**/api/case-types', route => route.fulfill(json({ caseTypes: ['Surgical Error'] })));
  let saved = { history: [] };
  await page.route('**/api/conversations/**', route => route.fulfill(json(saved)));
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/ask', async route => { await held; await route.fulfill(json({ answer: 'When did this happen?', cases: [] })); });
  await page.goto('/');
  await expect(page.locator('#conversation')).toHaveAttribute('role', 'log');
  await page.locator('#userInput').fill('My doctor missed a fracture.');
  await page.locator('#submitBtn').click();
  await expect(page.locator('#chatStatus')).toHaveText('Your message was sent. The answer usually takes 10 to 20 seconds.');
  await expect(page.locator('#conversation .msg-thinking')).toHaveAttribute('aria-hidden', 'true');
  release();
  await expect(page.locator('#conversation .msg-ai').last()).toContainText('When did this happen?');

  const history = [1, 2, 3, 4].flatMap(n => [{ role: 'user', content: 'Message ' + n }, { role: 'assistant', content: 'Reply ' + n }]);
  saved = { mode: 'personal', history, contactForm: true };
  await page.reload();
  await expect(page.locator('#conversation .contact-card')).toBeVisible();
  saved = { mode: 'personal', history, contactForm: false, contact_consent_at: '2026-11-14T10:00:00Z' };
  await page.reload();
  await expect(page.locator('#conversation .contact-done')).toContainText('Your request has been received');
});

test('a reply that arrived stays, even if showing part of it fails', async ({ page }) => {
  await mockBasics(page);
  // A case entry the page cannot show: rendering the case list fails after the reply was saved.
  await page.route('**/api/ask', route => route.fulfill(json({ answer: 'I am so sorry. When did this happen?', cases: [null] })));
  await page.goto('/');
  await page.locator('#userInput').fill('My surgeon operated on the wrong knee.');
  await page.locator('#submitBtn').click();
  await expect(page.locator('#conversation .msg-ai').last()).toContainText('When did this happen?');
  await expect(page.locator('#conversation .msg-user')).toHaveText('My surgeon operated on the wrong knee.');
  await expect(page.locator('#conversation .msg-notice')).toHaveCount(0);
  await expect(page.locator('#userInput')).toHaveValue('');
});
