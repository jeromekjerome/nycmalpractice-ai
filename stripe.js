// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
import Stripe from 'stripe';

function getStripe() { return new Stripe(process.env.STRIPE_SECRET_KEY); }

export async function createCustomer({ name, email }) {
  return getStripe().customers.create({ name, email });
}

export async function createSubscriptionCheckout({ stripeCustomerId, firmId }) {
  return getStripe().checkout.sessions.create({
    customer: stripeCustomerId || undefined,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${process.env.APP_URL}/portal.html?subscribed=1`,
    cancel_url:  `${process.env.APP_URL}/register.html?step=4`,
    metadata: { firmId: String(firmId) },
    subscription_data: { metadata: { firmId: String(firmId) } },
  });
}

export async function createPortalSession({ stripeCustomerId }) {
  return getStripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${process.env.APP_URL}/portal.html`,
  });
}

export async function constructWebhookEvent(body, signature) {
  return getStripe().webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

export async function chargeCustomer({ stripeCustomerId, paymentMethodId, amountDollars, description, metadata }) {
  return getStripe().paymentIntents.create({
    customer: stripeCustomerId, payment_method: paymentMethodId,
    amount: Math.round(amountDollars * 100), currency: 'usd',
    confirm: true, off_session: true, description, metadata,
  });
}

export async function createRefund({ paymentIntentId, amountDollars }) {
  return getStripe().refunds.create({
    payment_intent: paymentIntentId,
    amount: Math.round(amountDollars * 100),
  });
}
