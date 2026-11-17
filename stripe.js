// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
import Stripe from 'stripe';
import { APP_URL, APP_ID } from './site.js';
import { isDemo } from './demo.js';

// Requests go through fetch, so the tests can answer them offline.
let client = null;
function getStripe() {
  // The demo copy charges synthetic firms with Stripe's test cards only.
  if (isDemo() && /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '')) throw new Error('The demo refuses a live Stripe key; use a test key (sk_test_...).');
  client ||= new Stripe(process.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  return client;
}

export async function createCustomer({ name, email, firmId = null }) {
  return getStripe().customers.create({ name, email, ...(firmId ? { metadata: { firmId: String(firmId) } } : {}) });
}

// A firm finishing sign-up from its portal returns to the portal; one signing up returns to the sign-up page.
const CHECKOUT_RETURNS = {
  register: { success: '/register.html?subscribed=1', cancel: '/register.html?step=4&cancelled=1' },
  portal:   { success: '/portal.html?subscribed=1',   cancel: '/portal.html?checkout=cancelled' },
};

export async function createSubscriptionCheckout({ stripeCustomerId, firmId, from = 'register' }) {
  const returns = CHECKOUT_RETURNS[from] || CHECKOUT_RETURNS.register;
  return getStripe().checkout.sessions.create({
    // Always set: the route creates a customer first for a firm that has none. Without one, Checkout made a
    // customer of its own that was never saved, so the firm paid but could never be charged for a lead.
    customer: stripeCustomerId || undefined,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    // The site address has a default (site.js); an unset APP_URL made Stripe refuse the checkout.
    success_url: `${APP_URL}${returns.success}`,
    cancel_url:  `${APP_URL}${returns.cancel}`,
    // The app is named too (APP_ID), so another app sharing the Stripe account ignores this checkout.
    metadata: { firmId: String(firmId), app: APP_ID },
    client_reference_id: String(firmId),
    subscription_data: { metadata: { firmId: String(firmId), app: APP_ID } },
  });
}

// Returns to the firm portal, which keeps its sign-in link for the visit; it used to return to the sign-in form.
// The sign-in link itself is not given to Stripe.
export async function createPortalSession({ stripeCustomerId }) {
  return getStripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${APP_URL}/portal.html?billing=done`,
  });
}

const paymentMethodId = value => (typeof value === 'string' ? value : value?.id) || null;

// The customer's default card, which Manage Billing sets when a firm changes its card.
export async function getCustomerCard(stripeCustomerId) {
  const customer = await getStripe().customers.retrieve(stripeCustomerId);
  return paymentMethodId(customer?.invoice_settings?.default_payment_method);
}

// Every card Stripe holds as one of the firm's defaults: the customer's (Manage Billing sets it) and the
// subscription's (Checkout sets it). A lead charge declined on the stored card is tried on the others.
export async function cardsOnFile({ stripeCustomerId, stripeSubscriptionId }) {
  const cards = [];
  if (stripeCustomerId) cards.push(await getCustomerCard(stripeCustomerId));
  if (stripeSubscriptionId) {
    const sub = await getStripe().subscriptions.retrieve(stripeSubscriptionId);
    cards.push(paymentMethodId(sub?.default_payment_method));
  }
  return [...new Set(cards.filter(Boolean))];
}

// Synchronous on purpose: it was async and called without await, so the webhook never read an event, no
// firm's subscription was ever switched on, and a forged call was answered 200.
export function constructWebhookEvent(body, signature) {
  return getStripe().webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

// idempotencyKey: the same charge retried (a second run of the same close) is charged once.
// receiptEmail: Stripe emails the firm a receipt for the charge. Lead charges are not invoices, so the billing
// portal never lists them; without this the lead email was the firm's only record.
export async function chargeCustomer({ stripeCustomerId, paymentMethodId, amountDollars, description, metadata, idempotencyKey, receiptEmail }) {
  return getStripe().paymentIntents.create({
    customer: stripeCustomerId, payment_method: paymentMethodId,
    amount: Math.round(amountDollars * 100), currency: 'usd',
    confirm: true, off_session: true, description, metadata,
    ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
  }, idempotencyKey ? { idempotencyKey } : undefined);
}

export async function createRefund({ paymentIntentId, amountDollars, idempotencyKey }) {
  return getStripe().refunds.create({
    payment_intent: paymentIntentId,
    amount: Math.round(amountDollars * 100),
  }, idempotencyKey ? { idempotencyKey } : undefined);
}

// A new subscription's card, which later lead charges use, and the firm it was created for (checkout puts
// the firm id on the subscription as well as on the checkout session).
export async function getSubscriptionDetails(subscriptionId) {
  const sub = await getStripe().subscriptions.retrieve(subscriptionId, { expand: ['default_payment_method'] });
  return { paymentMethodId: sub.default_payment_method?.id || null, firmId: sub.metadata?.firmId || null, status: sub.status || null, app: sub.metadata?.app || null };
}

// A subscription the customer already has that is not over: checkout is refused while one exists, so a firm back
// from paying (before Stripe's event has switched it on) cannot start a second $199 subscription.
const LIVE_SUBSCRIPTION = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
export async function liveSubscription(stripeCustomerId) {
  const subs = await getStripe().subscriptions.list({ customer: stripeCustomerId, status: 'all', limit: 20 });
  return (subs?.data || []).find(sub => LIVE_SUBSCRIPTION.has(sub.status)) || null;
}
