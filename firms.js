// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import { neon } from '@neondatabase/serverless';
import { createCustomer } from './stripe.js';
import crypto from 'crypto';
import twilio from 'twilio';

const sql = neon(process.env.DATABASE_URL);

function twilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

export async function registerFirm({ name, email, phone }) {
  const existing = await sql`SELECT id FROM firms WHERE email = ${email} LIMIT 1`;
  if (existing.length > 0) return { firm: existing[0], isNew: false };

  let stripeCustomerId = null;
  try {
    const customer = await createCustomer({ name, email });
    stripeCustomerId = customer.id;
  } catch (err) { console.warn('Stripe customer creation failed:', err.message); }

  const [firm] = await sql`
    INSERT INTO firms (name, email, phone, stripe_customer_id)
    VALUES (${name}, ${email}, ${phone}, ${stripeCustomerId})
    RETURNING *
  `;
  return { firm, isNew: true };
}

export async function sendVerificationCode(firmId) {
  const code      = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await sql`INSERT INTO phone_codes (firm_id, code, expires_at) VALUES (${firmId}, ${code}, ${expiresAt})`;

  const [firm] = await sql`SELECT phone FROM firms WHERE id = ${firmId}`;
  const client  = twilioClient();

  if (client && firm?.phone) {
    await client.messages.create({
      body: `Your MalpracticeAI verification code: ${code}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   firm.phone,
    });
  } else {
    console.log(`[SMS MOCK] Verification code for firm ${firmId}: ${code}`);
  }
  return true;
}

export async function verifyPhoneCode(firmId, code) {
  const rows = await sql`
    SELECT id FROM phone_codes
    WHERE firm_id = ${firmId} AND code = ${code} AND verified = FALSE AND expires_at > NOW()
    ORDER BY created_at DESC LIMIT 1
  `;
  if (rows.length === 0) return false;
  await sql`UPDATE phone_codes SET verified = TRUE WHERE id = ${rows[0].id}`;
  await sql`UPDATE firms SET phone_verified = TRUE WHERE id = ${firmId}`;
  return true;
}

export async function createMagicLink(firmId, { auctionId = null, leadId = null, expiresInHours = 48 } = {}) {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
  await sql`INSERT INTO firm_tokens (firm_id, token, auction_id, lead_id, expires_at) VALUES (${firmId}, ${token}, ${auctionId}, ${leadId}, ${expiresAt})`;
  return token;
}

export async function validateToken(token) {
  const rows = await sql`
    SELECT ft.*, f.id as firm_id, f.name, f.email, f.phone_verified,
           f.subscription_active, f.suspended_until, f.stripe_customer_id,
           f.stripe_payment_method_id, f.auction_decline_count, f.cold_decline_count
    FROM firm_tokens ft
    JOIN firms f ON f.id = ft.firm_id
    WHERE ft.token = ${token} AND ft.expires_at > NOW()
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function getFirm(firmId) {
  const rows = await sql`SELECT * FROM firms WHERE id = ${firmId} LIMIT 1`;
  return rows[0] || null;
}

export async function getActiveFirms(caseType = null) {
  if (caseType) {
    return sql`
      SELECT * FROM firms
      WHERE active = TRUE AND phone_verified = TRUE AND subscription_active = TRUE
        AND (suspended_until IS NULL OR suspended_until < NOW())
        AND (specializations IS NULL OR array_length(specializations, 1) IS NULL OR ${caseType} = ANY(specializations))
    `;
  }
  return sql`
    SELECT * FROM firms
    WHERE active = TRUE AND phone_verified = TRUE AND subscription_active = TRUE
      AND (suspended_until IS NULL OR suspended_until < NOW())
  `;
}

export async function updateFirmProfile(firmId, { specializations, serviceArea, contactName }) {
  await sql`UPDATE firms SET specializations = ${specializations}, service_area = ${serviceArea}, contact_name = ${contactName} WHERE id = ${firmId}`;
}

export async function updateFirmSubscription(firmId, { stripeSubscriptionId, stripePaymentMethodId }) {
  await sql`
    UPDATE firms SET subscription_active = TRUE,
      stripe_subscription_id = ${stripeSubscriptionId},
      stripe_payment_method_id = ${stripePaymentMethodId}
    WHERE id = ${firmId}
  `;
}

export async function recordDecline(firmId, isAuction) {
  const firm = await getFirm(firmId);
  if (!firm) return;
  if (isAuction) {
    const newCount = (firm.auction_decline_count || 0) + 1;
    const suspendedUntil = newCount >= 3 ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null;
    await sql`UPDATE firms SET auction_decline_count = ${newCount}, suspended_until = ${suspendedUntil} WHERE id = ${firmId}`;
  } else {
    await sql`UPDATE firms SET cold_decline_count = ${(firm.cold_decline_count || 0) + 1} WHERE id = ${firmId}`;
  }
}

export async function resetDeclineCounts() {
  await sql`UPDATE firms SET auction_decline_count = 0, cold_decline_count = 0 WHERE created_at < NOW() - INTERVAL '30 days' OR auction_decline_count > 0 OR cold_decline_count > 0`;
}
