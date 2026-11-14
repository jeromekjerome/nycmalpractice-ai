// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
import Stripe from 'stripe';
import { APP_URL } from './site.js';

// Requests go through fetch, so the tests can answer them offline.
let client = null;
function getStripe() {
  client ||= new Stripe(process.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  return client;
}

export async function createCustomer({ name, email }) {
  return getStripe().customers.create({ name, email });
}

export async function createSubscriptionCheckout({ stripeCustomerId, firmId }) {
  return getStripe().checkout.sessions.create({
    customer: stripeCustomerId || undefined,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    // The site address has a default (site.js); an unset APP_URL made Stripe refuse the checkout. A firm
    // that pays lands on the sign-up page's last step, not on the portal, which needs a sign-in link.
    success_url: `${APP_URL}/register.html?subscribed=1`,
    cancel_url:  `${APP_URL}/register.html?step=4`,
    metadata: { firmId: String(firmId) },
    client_reference_id: String(firmId),
    subscription_data: { metadata: { firmId: String(firmId) } },
  });
}

export async function createPortalSession({ stripeCustomerId }) {
  return getStripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${APP_URL}/portal.html`,
  });
}

// Synchronous on purpose: it was async and called without await, so the webhook never read an event, no
// firm's subscription was ever switched on, and a forged call was answered 200.
export function constructWebhookEvent(body, signature) {
  return getStripe().webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

// idempotencyKey: the same charge retried (a second run of the same close) is charged once.
export async function chargeCustomer({ stripeCustomerId, paymentMethodId, amountDollars, description, metadata, idempotencyKey }) {
  return getStripe().paymentIntents.create({
    customer: stripeCustomerId, payment_method: paymentMethodId,
    amount: Math.round(amountDollars * 100), currency: 'usd',
    confirm: true, off_session: true, description, metadata,
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
  return { paymentMethodId: sub.default_payment_method?.id || null, firmId: sub.metadata?.firmId || null };
}
