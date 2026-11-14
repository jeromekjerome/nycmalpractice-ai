# NYCMalpractice.ai

AI-powered medical malpractice legal assistant for NYC. Guides both injured patients and families of wrongful death victims through the complexities of malpractice litigation, with built-in statute of limitations warnings and expert viability assessment.

---

## How It Works

Users describe their situation as either a patient who was personally harmed or a family member pursuing a wrongful death claim. The AI (gpt-4o) analyzes the conversation, identifies the case type, flags statute of limitations urgency, and pulls relevant NYC Supreme Court malpractice decisions via CourtListener.

As the conversation develops, the AI scores the lead in the background. Qualified leads are delivered directly to subscribed malpractice firms (cold tier) or go to a live auction where multiple firms bid for exclusive access to the contact. Malpractice is a high-value vertical — reserve prices are higher than other AntiGravity apps.

---

## Features

**For Users**
- Personal / Estate mode toggle — "I Was Harmed" vs "A Loved One Died"
- Personal mode: patient injury claims (CPLR §214-a — 2.5yr SOL from act/omission)
- Estate mode: wrongful death malpractice (EPTL §5-4.1 — 2yr SOL from date of death)
- Case types: surgical error, misdiagnosis, medication error, birth injury, anesthesia error, hospital negligence, nursing home abuse, dental malpractice
- Case analysis panel with complexity estimate (level + reason) and SOL warning when deadline is approaching
- NYC Supreme Court and Appellate Division decisions via CourtListener
- Conversation history persisted per session with personal/estate mode restoration

**For Law Firms**
- $199/month subscription for access to the lead marketplace
- Phone verification (Twilio SMS) on registration
- Lead tiers: Cold ($25), Warm ($100), Hot ($200), Premium ($400)
- Hot/Premium leads go to timed auctions (2–6 hours); firms bid in real time
- Cold leads go to up to three matching firms (the client agreed to "up to three"); an auction nobody wins is offered the same way
- Magic-link portal — no passwords; secure 30-day session links sent via email
- Lead accept/decline within 3-day window with tiered refund policy; a decline needs a reason, and a lead declined for the firm's own reasons, or left unanswered, is offered to firms that have not had it
- A firm that stopped part-way through sign-up finishes in its portal (verify or change the phone number, start the subscription)
- Lead charges follow the card set under Manage Billing; a firm whose card is declined is emailed a link to update it
- Firms suspended from auctions for 30 days after 3 declines in a billing period
- Firm profile: specializations, service area, contact name

**Admin**
- Admin dashboard at `/admin.html` — contact requests (read the conversation, deliver by hand to an approved firm), auctions (cancel a stuck one), leads with refunds and decline reasons, and firms with their activity
- Manually send portal links, toggle firm active status, update profiles
- Protected via `ADMIN_SECRET` header (`x-admin-secret`)

---

## Lead Scoring

Leads are scored 0–100 by gpt-4o-mini across five dimensions:

| Dimension | Weight | Notes |
|---|---|---|
| Injury severity | 30% | |
| Causation clarity | 25% | How clearly the harm connects to provider negligence |
| SOL status | 20% | 10 = well within deadline; 1–2 = likely expired |
| Expert viability | 15% | Likelihood a medical expert can support the claim |
| Damages magnitude | 10% | |

Leads below 55 or with AI confidence < 0.65 are discarded. SOL status is explicitly scored — cases approaching or past the statute of limitations score low and are less likely to reach firms.

Viable leads are tiered:

| Tier | Score | Reserve | Auction Window |
|---|---|---|---|
| Cold | 55–69 | $25 | Direct delivery |
| Warm | 70–79 | $100 | 2 hours |
| Hot | 80–89 | $200 | 4 hours |
| Premium | 90–100 | $400 | 6 hours |

---

## Statute of Limitations

The AI is SOL-aware for both claim types:

| Claim Type | Statute | SOL |
|---|---|---|
| Personal injury (patient) | CPLR §214-a | 2.5 years from act or omission |
| Wrongful death (estate) | EPTL §5-4.1 | 2 years from date of death |

When the SOL is approaching, the case analysis panel displays a `.factor-warn` alert in yellow. Leads with likely-expired SOL are scored low and typically dropped before reaching firms.

---

## Decline Policy

| Scenario | Refund |
|---|---|
| Cold lead decline (1st–3rd this month) | 100% |
| Cold lead decline (4th+ this month) | 50% |
| Auction lead decline (1st this month) | 50% |
| Auction lead decline (2nd this month) | 25% |
| Auction lead decline (3rd this month) | 0% + 30-day auction suspension |

---

## Database Schema

Seven tables in Neon Postgres (separate database from other AntiGravity apps):

- **firms** — subscribed law firms, Stripe IDs, decline counts, suspension state
- **phone_codes** — Twilio SMS verification codes
- **firm_tokens** — magic links for portal, auction, and lead access
- **conversations** — full chat history per session, with extracted name/phone/best_time and personal/estate mode
- **user_interactions** — per-message log with `lead_email_sent` flag to prevent duplicate delivery
- **auctions** — open/closed auctions with tier, score, bids, and lead data
- **bids** — individual firm bids per auction
- **leads** — delivered leads with status (pending/accepted/declined), price paid, and refund tracking

---

## Tech Stack

- **Backend:** Node.js / Express (ESM)
- **AI:** OpenAI gpt-4o (chat/analysis) + gpt-4o-mini (lead scoring)
- **Case Law:** CourtListener API (NY Supreme Court, Appellate Division — no family court)
- **Database:** Neon Postgres (`@neondatabase/serverless`)
- **Payments:** Stripe (subscriptions + per-lead charges + refunds)
- **SMS:** Twilio (phone verification)
- **Email:** Nodemailer via SMTP (lead delivery, portal links, auction notifications)
- **Frontend:** Vanilla HTML/CSS/JS, glassmorphism UI — deep crimson (#9e3a5a) for personal mode, deep plum (#6e3a7c) for estate/wrongful death mode
- **Deploy:** Vercel (serverless), Cloudflare DNS + Email Routing
- **Cron:** Vercel built-in cron (daily reset) + cron-job.org (auction closing, overdue leads)

---

## Setup

**1. Clone and install**
```bash
npm install
```

**2. Configure environment**
```bash
cp .env.example .env
```

Fill in all values — see the table below.

**3. Initialize the database**
```bash
npm run setup-db
```

**4. Run locally**
```bash
npm start
```

Server runs at `http://localhost:3003`.

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string (separate DB from other apps) |
| `OPENAI_API_KEY` | OpenAI API key |
| `COURTLISTENER_TOKEN` | CourtListener API token (optional) |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_ID` | Stripe price ID for the $199/mo subscription |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Twilio outbound phone number |
| `SMTP_HOST` | SMTP server host |
| `SMTP_PORT` | SMTP port (default: 465) |
| `SMTP_USER` | SMTP username / from address |
| `SMTP_PASS` | SMTP password |
| `APP_URL` | Public app URL (e.g. `https://nycmalpractice.ai`) |
| `CRON_SECRET` | Bearer token for cron endpoint auth |
| `ADMIN_SECRET` | Header secret for admin API routes |
| `NOTIFICATION_EMAIL` | Operator notices: new firms, unplaced leads, declined cards, failed refunds, chat and contact-form failures, failed nightly steps, and a daily summary (`DAILY_DIGEST=off` stops the summary) |

---

## Deploy

```bash
vercel --name nycmalpractice-ai --prod
```

Set all environment variables in the Vercel dashboard. The nightly job (`/api/cron`) runs via Vercel at 7am UTC (2am ET). Each of its steps runs even if an earlier one fails; failed steps are emailed to the operator with a summary of the day. `/health/deep` answers 503 when the database cannot be reached, lacks a column the code uses, or the nightly job has not succeeded in 26 hours: point an uptime monitor at it.

**cron-job.org** — two additional jobs needed:

| Job | URL | Schedule | Header |
|---|---|---|---|
| Close auctions | `https://nycmalpractice.ai/api/cron/close-auctions` | Every 5 minutes | `Authorization: Bearer <CRON_SECRET>` |
| Overdue leads | `https://nycmalpractice.ai/api/cron/overdue-leads` | Every hour | `Authorization: Bearer <CRON_SECRET>` |

**Post-deploy checklist:**
1. Register `nycmalpractice.ai` on Cloudflare Registrar
2. Point Cloudflare DNS to Vercel
3. Set up Cloudflare Email Routing for `hello@`, `legal@`, `privacy@nycmalpractice.ai`
4. Register Stripe webhook at `https://nycmalpractice.ai/api/webhooks/stripe` with `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid` and `customer.updated`
5. Set `APP_URL=https://nycmalpractice.ai` in Vercel env vars

---

## License

Proprietary. Copyright © 2026 Jerome W. Dewald. All rights reserved. See [LICENSE](LICENSE).
