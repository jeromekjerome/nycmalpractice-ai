import { test, expect } from '@playwright/test';

const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const openAuction = (fields = {}) => ({
  id: 9, status: 'open', tier: 'hot', tierConfig: { label: 'Hot' }, caseType: 'misdiagnosis', qualityScore: 82, preview: 'A delayed cancer diagnosis.',
  currentBid: 420, secsLeft: 3600, bidCount: 1, recentBids: [{ amount: 420 }], isLeading: false, myBid: null, firmName: 'Roe & Partners', ...fields,
});

test('a bid is sent only after the firm confirms the amount it agrees to pay', async ({ page }) => {
  const bids = [];
  await page.route(url => url.pathname === '/api/auctions/9', route => route.fulfill(json(openAuction())));
  await page.route('**/api/auctions/9/bid', async route => { bids.push(route.request().postDataJSON()); await route.fulfill(json({ ok: true, currentBid: 500 })); });
  await page.goto('/auction.html?id=9&token=auction-token');
  await expect(page.locator('#bidAmount')).toHaveValue('421');

  await page.locator('#bidAmount').fill('500');
  await page.locator('#bidButton').click();
  await expect(page.locator('#bidConfirmText')).toHaveText('You agree to pay $500.00 if you win. Winning bids are binding, and your card is charged when the auction closes.');
  await expect(page.locator('#confirmBidBtn')).toHaveText('Confirm $500.00 bid');
  expect(bids).toEqual([]);

  // Changing the amount cancels the confirmation: the confirmed amount is the one sent.
  await page.locator('#bidAmount').fill('5000');
  await expect(page.locator('#bidConfirm')).toBeHidden();
  await expect(page.locator('#bidButton')).toBeVisible();
  expect(bids).toEqual([]);

  await page.locator('#bidAmount').fill('500');
  await page.locator('#bidButton').click();
  await page.locator('#confirmBidBtn').click();
  await expect.poll(() => bids).toEqual([{ token: 'auction-token', amount: 500 }]);
  await expect(page.locator('#bidMessage')).toContainText('Bid of $500.00 placed');
  await expect(page.locator('#bidConfirm')).toBeHidden();
});

const PORTAL_DATA = url => url.pathname === '/api/portal';
const portalFirm = { id: 7, name: 'Roe & Partners', email: 'intake@roe.example', phone: '+15551234567', phone_verified: true,
  subscription_active: true, subscription_status: 'active', stripe_customer_id: 'cus_7', approved_at: '2026-11-01T00:00:00Z', specializations: [] };
const lead = (id, fields = {}) => ({ id, case_type: 'misdiagnosis', tier: 'cold', price_paid: '25.00', refund_amount: null, status: 'accepted', decline_reason: null,
  from_auction: false, created_at: '2026-11-10T15:00:00Z', accepted_at: '2026-11-11T15:00:00Z', declined_at: null, ...fields });

test("the portal opens every lead, shows refunds, answers and this month's totals, more leads on request, and opens an open auction", async ({ page }) => {
  const first = [lead(501, { status: 'declined', refund_amount: '25.00', accepted_at: null, declined_at: '2026-11-12T15:00:00Z' }),
    ...Array.from({ length: 19 }, (_, i) => lead(500 - i, { from_auction: i === 0, tier: i === 0 ? 'hot' : 'cold', price_paid: i === 0 ? '420.00' : '25.00' }))];
  const asked = [];
  await page.route(PORTAL_DATA, route => {
    const url = new URL(route.request().url());
    asked.push(url.searchParams.get('offset'));
    return route.fulfill(json(url.searchParams.get('offset') === '20'
      ? { leads: [lead(481)], hasMore: false, nextOffset: 21 }
      : { firm: portalFirm, leads: first, hasMore: true, nextOffset: 20, month: { leads: 3, charged: 470, refunded: 25 },
        auctions: [{ id: 9, caseType: 'misdiagnosis', tier: 'hot', currentBid: 420, closesAt: '2030-01-01T00:00:00Z', leading: true }] }));
  });
  let linkFor;
  await page.route('**/api/portal/auction-link', async route => { linkFor = route.request().postDataJSON(); await route.fulfill(json({ url: '/auction.html?id=9&token=fresh-token' })); });
  await page.route(url => url.pathname === '/api/auctions/9', route => route.fulfill(json(openAuction({ isLeading: true }))));

  await page.goto('/portal.html?token=portal-token');
  await expect(page.locator('#monthSummary')).toHaveText('This month: 3 leads, $470.00 charged, $25.00 refunded.');
  await expect(page.locator('#statTotal')).toHaveText('20+');
  const rows = page.locator('#leadsBody tr');
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText('$25.00');   // the refund
  await expect(rows.first()).toContainText('declined');
  await expect(rows.nth(1)).toContainText('auction');
  // An accepted lead opens too: its link used to be shown only while it was pending.
  await expect(rows.nth(2).getByRole('link', { name: 'View →' })).toHaveAttribute('href', 'lead.html?id=499&token=portal-token');

  await page.locator('#moreLeadsBtn').click();
  await expect(rows).toHaveCount(21);
  await expect(page.locator('#moreLeadsBtn')).toBeHidden();
  expect(asked).toEqual([null, '20']);

  await expect(page.locator('#auctionsSection')).toContainText('you are leading');
  await page.getByRole('button', { name: 'Open auction' }).click();
  await expect(page).toHaveURL(/\/auction\.html\?id=9&token=fresh-token$/);
  expect(linkFor).toEqual({ token: 'portal-token', auctionId: '9' });
});
