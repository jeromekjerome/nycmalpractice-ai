// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import { neon } from '@neondatabase/serverless';
import { createCustomer } from './stripe.js';
import crypto from 'crypto';
import twilio from 'twilio';
import { PRACTICE_AREAS } from './site.js';

const sql = neon(process.env.DATABASE_URL);

function twilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// A firm's email is kept in lower case and matched without regard to case, so Intake@Firm.com cannot register
// a second time or miss its sign-in link. Its phone number is kept in the +1 form Twilio needs: a number typed
// as (212) 555-0100 was stored as typed.
export const normalizeEmail = email => String(email ?? '').trim().toLowerCase();

export function toE164(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

export async function findFirmByEmail(email) {
  const [firm] = await sql`SELECT id, name, email FROM firms WHERE lower(email) = ${normalizeEmail(email)} LIMIT 1`;
  return firm || null;
}

export async function registerFirm({ name, email, phone, attorneyName = null, attorneyRegistration = null }) {
  const cleanEmail = normalizeEmail(email);
  const existing = await findFirmByEmail(cleanEmail);
  if (existing) return { firm: existing, isNew: false };

  // A Stripe customer now if possible; ensureStripeCustomer makes one at checkout if this fails.
  let stripeCustomerId = null;
  try {
    const customer = await createCustomer({ name, email: cleanEmail });
    stripeCustomerId = customer.id;
  } catch (err) { console.warn('Stripe customer creation failed:', err.message); }

  const [firm] = await sql`
    INSERT INTO firms (name, email, phone, stripe_customer_id, attorney_name, attorney_registration)
    VALUES (${name}, ${cleanEmail}, ${toE164(phone)}, ${stripeCustomerId}, ${attorneyName}, ${attorneyRegistration})
    RETURNING *
  `;
  return { firm, isNew: true };
}

// A firm whose Stripe customer could not be made at sign-up (a Stripe error) gets one when it goes to pay. It
// used to have none, so Checkout made a customer of its own that was never saved: the firm paid $199 a month
// but could never be charged for a lead.
export async function ensureStripeCustomer(firm) {
  if (firm.stripe_customer_id) return firm.stripe_customer_id;
  const customer = await createCustomer({ name: firm.name, email: firm.email, firmId: firm.id });
  const [saved] = await sql`
    UPDATE firms SET stripe_customer_id = COALESCE(stripe_customer_id, ${customer.id})
    WHERE id = ${firm.id} RETURNING stripe_customer_id`;
  return saved?.stripe_customer_id || customer.id;
}

// A firm that typed a wrong number, or a landline that cannot take texts, corrects it before verifying. A
// verified number is not changed here.
export async function changeUnverifiedPhone(firmId, phone) {
  const rows = await sql`
    UPDATE firms SET phone = ${toE164(phone)}
    WHERE id = ${firmId} AND phone_verified IS NOT TRUE
    RETURNING id, phone`;
  return rows[0] || null;
}

// Thrown when a verification text may not be sent yet; the message is safe to show.
export class VerificationLimitError extends Error {}

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODES_PER_HOUR = 5;          // per firm, and per phone number across firms
const MIN_SECONDS_BETWEEN_CODES = 60;
const MAX_ATTEMPTS_PER_CODE = 5;

export async function sendVerificationCode(firmId) {
  const [firm] = await sql`SELECT phone FROM firms WHERE id = ${firmId}`;
  if (!firm) return false;

  // Each text costs money, and an open endpoint could be used to text any number, so the limits are
  // kept in the database where they hold across server instances.
  const [recent] = await sql`
    SELECT count(*) FILTER (WHERE pc.firm_id = ${firmId})::int AS for_firm,
           count(*)::int AS for_phone,
           count(*) FILTER (WHERE pc.firm_id = ${firmId} AND pc.created_at > NOW() - make_interval(secs => ${MIN_SECONDS_BETWEEN_CODES}))::int AS just_sent
    FROM phone_codes pc JOIN firms f ON f.id = pc.firm_id
    WHERE f.phone = ${firm.phone} AND pc.created_at > NOW() - INTERVAL '1 hour'`;
  if ((recent?.for_firm || 0) >= MAX_CODES_PER_HOUR || (recent?.for_phone || 0) >= MAX_CODES_PER_HOUR) {
    throw new VerificationLimitError('Too many codes have been requested for this phone number. Please try again in an hour.');
  }
  if ((recent?.just_sent || 0) > 0) {
    throw new VerificationLimitError('Please wait a minute before requesting another code.');
  }

  // Only the newest code works.
  await sql`UPDATE phone_codes SET expires_at = NOW() WHERE firm_id = ${firmId} AND verified = FALSE AND expires_at > NOW()`;
  const code      = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await sql`INSERT INTO phone_codes (firm_id, code, expires_at) VALUES (${firmId}, ${code}, ${expiresAt})`;

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
  // Only the newest unexpired code counts, and it stops working after a few wrong guesses.
  const [current] = await sql`
    SELECT id, code FROM phone_codes
    WHERE firm_id = ${firmId} AND verified = FALSE AND expires_at > NOW()
    ORDER BY created_at DESC LIMIT 1
  `;
  if (!current) return false;
  if (String(code) !== String(current.code)) {
    await sql`
      UPDATE phone_codes
      SET attempts = COALESCE(attempts, 0) + 1,
          expires_at = CASE WHEN COALESCE(attempts, 0) + 1 >= ${MAX_ATTEMPTS_PER_CODE} THEN NOW() ELSE expires_at END
      WHERE id = ${current.id}`;
    return false;
  }
  await sql`UPDATE phone_codes SET verified = TRUE WHERE id = ${current.id}`;
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
           f.stripe_payment_method_id, f.auction_decline_count, f.cold_decline_count, f.approved_at
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
      WHERE active = TRUE AND phone_verified = TRUE AND subscription_active = TRUE AND approved_at IS NOT NULL
        AND (suspended_until IS NULL OR suspended_until < NOW())
        -- "All Malpractice" on the registration form is stored as 'other' and means every case type.
        AND (specializations IS NULL OR array_length(specializations, 1) IS NULL OR 'other' = ANY(specializations) OR ${caseType} = ANY(specializations))
    `;
  }
  return sql`
    SELECT * FROM firms
    WHERE active = TRUE AND phone_verified = TRUE AND subscription_active = TRUE AND approved_at IS NOT NULL
      AND (suspended_until IS NULL OR suspended_until < NOW())
  `;
}

// Only the practice areas the forms offer are stored, and the free-text fields are capped plain text: they
// are shown on the admin page, and were stored exactly as sent.
export async function updateFirmProfile(firmId, { specializations, serviceArea, contactName }) {
  const areas = [...new Set((Array.isArray(specializations) ? specializations : []).filter(area => PRACTICE_AREAS.includes(area)))];
  // A field left out of the request is left as it is: the portal saves only the practice areas.
  const given = value => value !== undefined;
  const plainText = (value, max) => (typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '') || null;
  await sql`
    UPDATE firms
    SET specializations = CASE WHEN ${given(specializations)} THEN ${areas} ELSE specializations END,
        service_area    = CASE WHEN ${given(serviceArea)} THEN ${plainText(serviceArea, 200)} ELSE service_area END,
        contact_name    = CASE WHEN ${given(contactName)} THEN ${plainText(contactName, 100)} ELSE contact_name END
    WHERE id = ${firmId}
  `;
}

// A completed checkout switches the firm on, unless Stripe already reports the subscription unpaid: a late
// retry of this event used to switch back on a firm that a failed payment had switched off. The customer that
// paid is saved with the card: the card belongs to that customer, and lead charges need both.
export async function updateFirmSubscription(firmId, { stripeSubscriptionId, stripePaymentMethodId, stripeCustomerId = null, status = null }) {
  const paidUp = status ? PAID_UP_STATUSES.includes(status) : true;
  await sql`
    UPDATE firms SET subscription_active = ${paidUp}, subscription_status = ${status || 'active'},
      stripe_subscription_id = ${stripeSubscriptionId},
      stripe_customer_id = COALESCE(${stripeCustomerId}, stripe_customer_id),
      card_declined_at = CASE WHEN ${stripePaymentMethodId}::text IS NULL THEN card_declined_at ELSE NULL END,
      stripe_payment_method_id = COALESCE(${stripePaymentMethodId}, stripe_payment_method_id)
    WHERE id = ${firmId}
  `;
}

// Declines in the last 30 days, which the refund and suspension rules count (Terms: "Declines are
// counted over the preceding 30 days"). leads.declined_at is set on every decline, including the
// automatic decline of a lead nobody answered.
export async function recentDeclineCounts(firmId) {
  const [row] = await sql`
    SELECT count(*) FILTER (WHERE auction_id IS NOT NULL)::int AS auction,
           count(*) FILTER (WHERE auction_id IS NULL)::int AS cold
    FROM leads
    WHERE firm_id = ${firmId} AND status = 'declined' AND declined_at > NOW() - INTERVAL '30 days'`;
  return { auction: row?.auction || 0, cold: row?.cold || 0 };
}

// Called after a lead has been marked declined. The third auction decline within 30 days suspends the
// firm for 30 days. An existing suspension is kept: a later decline used to lift it.
export async function recordDecline(firmId, isAuction) {
  const counts  = await recentDeclineCounts(firmId);
  const suspend = isAuction && counts.auction >= 3;
  await sql`
    UPDATE firms
    SET auction_decline_count = ${counts.auction}, cold_decline_count = ${counts.cold},
        suspended_until = CASE WHEN ${suspend} THEN NOW() + INTERVAL '30 days' ELSE suspended_until END
    WHERE id = ${firmId}`;
}

// Nightly: declines older than 30 days drop off the firm's counts. This used to set every firm's
// counts to zero each night, so the escalating refund rules never escalated.
export async function resetDeclineCounts() {
  await sql`
    UPDATE firms SET
      auction_decline_count = (SELECT count(*) FROM leads l WHERE l.firm_id = firms.id AND l.status = 'declined' AND l.auction_id IS NOT NULL AND l.declined_at > NOW() - INTERVAL '30 days'),
      cold_decline_count    = (SELECT count(*) FROM leads l WHERE l.firm_id = firms.id AND l.status = 'declined' AND l.auction_id IS NULL AND l.declined_at > NOW() - INTERVAL '30 days')`;
}

// What a firm link opens. A link emailed for one auction opens only that auction, and one emailed for one
// lead only that lead; the portal link (and the registration token) open the firm's own account, billing
// and its leads. Every link used to open everything, and any firm could open any auction by its number.
export function linkOpensAuction(tokenData, auctionId) {
  return tokenData?.auction_id != null && String(tokenData.auction_id) === String(auctionId);
}

export function linkOpensLead(tokenData, leadId) {
  if (!tokenData || tokenData.auction_id != null) return false;
  return tokenData.lead_id == null || String(tokenData.lead_id) === String(leadId);
}

export function linkOpensAccount(tokenData) {
  return !!tokenData && tokenData.auction_id == null && tokenData.lead_id == null;
}

// ── Approval and paid-up subscriptions ────────────────────────────────────────
// A firm gets leads only once the operator has checked its supervising attorney's New York registration (the
// consent text promises licensed New York attorneys, and sign-up checked nothing), and only while its
// subscription is paid up.
export async function approveFirm(firmId, approved) {
  const [firm] = await sql`
    UPDATE firms SET approved_at = CASE WHEN ${approved} THEN COALESCE(approved_at, NOW()) ELSE NULL END
    WHERE id = ${firmId}
    RETURNING id, approved_at`;
  return firm || null;
}

// Stripe's statuses that count as paid up. Past due, unpaid, canceled, incomplete and paused subscriptions
// switch the firm off until Stripe reports it paid again; a failed payment used to leave the leads coming.
export const PAID_UP_STATUSES = Object.freeze(['active', 'trialing']);

// The subscription's card is saved with its status: lead charges used to keep the card from the first checkout
// after the firm replaced it. A card that changes clears an earlier decline.
export async function setSubscriptionStatus(subscriptionId, status, paymentMethodId = null) {
  const paidUp = PAID_UP_STATUSES.includes(status);
  const rows = await sql`
    UPDATE firms SET subscription_active = ${paidUp}, subscription_status = ${status || null},
      card_declined_at = CASE WHEN ${paymentMethodId}::text IS DISTINCT FROM stripe_payment_method_id AND ${paymentMethodId}::text IS NOT NULL THEN NULL ELSE card_declined_at END,
      stripe_payment_method_id = COALESCE(${paymentMethodId}, stripe_payment_method_id)
    WHERE stripe_subscription_id = ${subscriptionId}
    RETURNING id`;
  return rows.length;
}

// The card a firm chose under Manage Billing (Stripe's customer.updated event).
export async function setCustomerCard(stripeCustomerId, paymentMethodId) {
  if (!stripeCustomerId || !paymentMethodId) return 0;
  const rows = await sql`
    UPDATE firms SET stripe_payment_method_id = ${paymentMethodId},
      card_declined_at = CASE WHEN stripe_payment_method_id IS DISTINCT FROM ${paymentMethodId} THEN NULL ELSE card_declined_at END
    WHERE stripe_customer_id = ${stripeCustomerId}
    RETURNING id`;
  return rows.length;
}

// A card a lead charge found on file, and charged, after the stored one was declined.
export async function setFirmCard(firmId, paymentMethodId) {
  await sql`UPDATE firms SET stripe_payment_method_id = ${paymentMethodId}, card_declined_at = NULL WHERE id = ${firmId}`;
}

// A declined lead charge is reported to the firm at most once a day. The time is shown in the portal until a new
// card is saved or a charge goes through. Returns whether this decline is the one to report.
export async function claimCardDeclinedNotice(firmId) {
  const rows = await sql`
    UPDATE firms SET card_declined_at = NOW()
    WHERE id = ${firmId} AND (card_declined_at IS NULL OR card_declined_at < NOW() - INTERVAL '24 hours')
    RETURNING id`;
  return rows.length > 0;
}

export async function clearCardDeclined(firmId) {
  await sql`UPDATE firms SET card_declined_at = NULL WHERE id = ${firmId} AND card_declined_at IS NOT NULL`;
}
