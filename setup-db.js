// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Proprietary and confidential. See LICENSE for terms.

import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

async function setup() {
  console.log('Setting up NYCMalpractice.ai database…');

  await sql`
    CREATE TABLE IF NOT EXISTS firms (
      id                       SERIAL PRIMARY KEY,
      name                     TEXT NOT NULL,
      email                    TEXT UNIQUE NOT NULL,
      phone                    TEXT,
      phone_verified           BOOLEAN DEFAULT FALSE,
      active                   BOOLEAN DEFAULT TRUE,
      subscription_active      BOOLEAN DEFAULT FALSE,
      stripe_customer_id       TEXT,
      stripe_subscription_id   TEXT,
      stripe_payment_method_id TEXT,
      suspended_until          TIMESTAMPTZ,
      auction_decline_count    INT DEFAULT 0,
      cold_decline_count       INT DEFAULT 0,
      specializations          TEXT[],
      service_area             TEXT,
      contact_name             TEXT,
      terms_accepted_at        TIMESTAMPTZ,
      created_at               TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS phone_codes (
      id         SERIAL PRIMARY KEY,
      firm_id    INT REFERENCES firms(id),
      code       TEXT NOT NULL,
      verified   BOOLEAN DEFAULT FALSE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE phone_codes ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0`;  // wrong guesses for this code

  await sql`
    CREATE TABLE IF NOT EXISTS firm_tokens (
      id         SERIAL PRIMARY KEY,
      firm_id    INT REFERENCES firms(id),
      token      TEXT UNIQUE NOT NULL,
      auction_id INT,
      lead_id    INT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS conversations (
      id          SERIAL PRIMARY KEY,
      session_id  TEXT UNIQUE NOT NULL,
      mode        TEXT DEFAULT 'personal',  -- personal | estate
      case_type   TEXT,                     -- surgical_error | misdiagnosis | medication_error | birth_injury | anesthesia_error | hospital_negligence | nursing_home | dental | other
      history     JSONB DEFAULT '[]',
      name        TEXT,
      phone       TEXT,
      best_time   TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Columns added after the table was first created. CREATE TABLE IF NOT EXISTS never adds a column to
  // a table that already exists, so each one is added here explicitly.
  await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_score JSONB`;               // latest qualifying lead score
  await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS contact_consent_at TIMESTAMPTZ`; // when the visitor agreed to be contacted
  await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS contact_consent_text TEXT`;      // the exact wording agreed to
  await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_sent_at TIMESTAMPTZ`;             // when the lead went to firms (once)
  await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS gate_audit JSONB`;               // the gate's audit of the latest reply

  await sql`
    CREATE TABLE IF NOT EXISTS user_interactions (
      id              SERIAL PRIMARY KEY,
      session_id      TEXT NOT NULL,
      question        TEXT,
      mode            TEXT,
      case_type       TEXT,
      lead_email_sent BOOLEAN DEFAULT FALSE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS auctions (
      id                  SERIAL PRIMARY KEY,
      session_id          TEXT NOT NULL,
      case_type           TEXT,
      quality_score       INT,
      tier                TEXT,
      reserve_price       DECIMAL(10,2),
      current_bid         DECIMAL(10,2),
      current_leader_id   INT REFERENCES firms(id),
      winner_firm_id      INT REFERENCES firms(id),
      winning_bid         DECIMAL(10,2),
      status              TEXT DEFAULT 'open',
      closes_at           TIMESTAMPTZ,
      score_dimensions    JSONB,
      lead_preview        TEXT,
      lead_data           JSONB,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS bids (
      id          SERIAL PRIMARY KEY,
      auction_id  INT REFERENCES auctions(id),
      firm_id     INT REFERENCES firms(id),
      amount      DECIMAL(10,2) NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS leads (
      id                SERIAL PRIMARY KEY,
      auction_id        INT REFERENCES auctions(id),
      firm_id           INT REFERENCES firms(id),
      session_id        TEXT,
      case_type         TEXT,
      tier              TEXT,
      price_paid        DECIMAL(10,2),
      stripe_charge_id  TEXT,
      stripe_refund_id  TEXT,
      refund_amount     DECIMAL(10,2),
      status            TEXT DEFAULT 'pending',
      accept_deadline   TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // A cold lead has no auction row, so the lead itself keeps what the firm bought.
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_data JSONB`;
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ`;  // decline counts look back 30 days from here
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ`;        // when the firm accepted it
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS hitl_verification JSONB`;        // the supervising attorney's checks, as attested
  await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS email TEXT`;                // optional, given in the contact form
  await sql`ALTER TABLE firms ADD COLUMN IF NOT EXISTS attorney_name TEXT`;                // the supervising attorney, given at sign-up
  await sql`ALTER TABLE firms ADD COLUMN IF NOT EXISTS attorney_registration TEXT`;        // their New York attorney registration number
  await sql`ALTER TABLE firms ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`;           // set by the operator after checking it; no leads before
  await sql`ALTER TABLE firms ADD COLUMN IF NOT EXISTS subscription_status TEXT`;          // Stripe's status: active, past_due, canceled ...
  await sql`ALTER TABLE firms ADD COLUMN IF NOT EXISTS card_declined_at TIMESTAMPTZ`;      // when the firm was last told a lead charge was declined
  await sql`ALTER TABLE firms ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`;     // when the firm agreed to the Terms of Service at sign-up
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS decline_reason TEXT`;              // why the firm declined (auction.js DECLINE_REASONS), or 'expired'
  // How each chat message ended, so failures leave a record (operations.js).
  await sql`ALTER TABLE user_interactions ADD COLUMN IF NOT EXISTS outcome TEXT`;         // ok | slow | error
  await sql`ALTER TABLE user_interactions ADD COLUMN IF NOT EXISTS latency_ms INT`;
  await sql`ALTER TABLE user_interactions ADD COLUMN IF NOT EXISTS gate_status TEXT`;     // the gate's verdict on the reply
  await sql`CREATE INDEX IF NOT EXISTS idx_interactions_created ON user_interactions(created_at)`;  // the failure checks and the daily summary
  await sql`ALTER TABLE phone_codes ADD COLUMN IF NOT EXISTS phone TEXT`;                 // the number a code was sent to; it verifies only that number
  // Each run of the nightly job, which /health/deep reads.
  await sql`
    CREATE TABLE IF NOT EXISTS job_runs (
      id            SERIAL PRIMARY KEY,
      job           TEXT NOT NULL,
      ok            BOOLEAN NOT NULL,
      failed_steps  JSONB,
      ran_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job, ran_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id                 BIGSERIAL PRIMARY KEY,
      operation          TEXT NOT NULL,
      model              TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'reserved',
      reserved_cost_usd  NUMERIC(12,8) NOT NULL,
      actual_cost_usd    NUMERIC(12,8),
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      error_code         TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at)`;

  // The last decisions found for each case type, used when CourtListener cannot be searched (case-memory.js).
  await sql`
    CREATE TABLE IF NOT EXISTS search_cache (
      case_type   TEXT PRIMARY KEY,
      cases       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  console.log('Database setup complete.');
}

setup().catch(err => { console.error('Setup failed:', err); process.exit(1); });
