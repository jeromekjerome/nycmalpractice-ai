# NYCMalpractice.ai

AI-powered medical malpractice legal assistant for NYC. Guides both injured patients and families of wrongful death victims through the complexities of malpractice litigation, with built-in statute of limitations warnings and expert viability assessment.

---

## How It Works

Users describe their situation as either a patient who was personally harmed or a family member pursuing a wrongful death claim. The AI analyzes the conversation, identifies the case type, flags statute of limitations urgency, and pulls relevant NYC Supreme Court malpractice decisions via CourtListener.

As the conversation develops, the AI scores the lead in the background. Qualified leads are delivered directly to subscribed malpractice firms (cold tier) or go to a live auction where multiple firms bid for exclusive access to the contact. Malpractice is a high-value vertical — reserve prices are higher than other AntiGravity apps.

---

## Features

**For Users**
- Personal / Estate mode toggle — "I Was Harmed" vs "A Loved One Died"
- Personal mode: patient injury claims (CPLR §214-a — 2.5yr SOL from act/omission)
- Estate mode: wrongful death malpractice (EPTL §5-4.1 — 2yr SOL from date of death)
- Case types: surgical error, misdiagnosis, medication error, birth injury, anesthesia error, hospital negligence, nursing home abuse, dental malpractice
- Case analysis panel with complexity estimate (level + reason) and SOL warning when deadline is approaching
- NYC Supreme Court and Appellate Division decisions via CourtListener, from the case library or a live search, each saying whether and when it was screened
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
- The Models section: the order of models each job runs with, which providers answer, what has been measured, and a form to change the order
- Manually send portal links, toggle firm active status, update profiles
- The Decisions held section: the library decisions the nightly screen held, with what it found, and Clear, Screen again or Ban for each
- Protected via `ADMIN_SECRET` header (`x-admin-secret`)

---

## The case library

Replies use the case library (`case-library.js`): the court decisions a nightly refresh finds on CourtListener with each case type's topic searches (`case-topics.js`, `library-refresh.js`), each put through a nightly screen (`case-screen.js`).

- A case type with five or more clear decisions is answered from the library: the five that share the most words with the conversation's search terms, the newer first on a tie. No case law search is sent while the visitor waits.
- A type with fewer searches CourtListener live, New York courts first, then a national search. The last decisions found for each case type are kept (`case-memory.js`) and used when the search fails.
- Either way, a decision the screen held or the owner banned is never used, and each decision shown says whether, and on what day, it was screened. If the library cannot be counted or picked from, the reply searches live; if the screen states of a live reply's decisions cannot be read, it is given none; if the library's tables have not been made yet, every decision is shown as not screened.
- The screen runs twice a night over the decisions due: those never screened, then those last screened 30 days ago or more. For each it asks CourtListener whether a later decision that cites it has one of a few words (such as "overruled") near its party's name, and, for a decision below the Court of Appeals, whether a higher court has since filed a decision under the same party names. A later decision the owner was already shown is not asked about again.
  - Nothing found: the decision is clear.
  - Anything found: it is held, left out of replies, and the owner is emailed what was found and how many later decisions there were. The owner decides on the admin page (Decisions held): Clear, Ban, or, for a decision whose answer could not be read, Screen again.
  - It is a filter that errs toward holding, not a citator.
- The gate's check of a citation against CourtListener is counted with the other requests, under `gate-lookup`.

---

## Lead Scoring

Leads are scored 0–100 by the small-job model (gpt-6-luna) across five dimensions:

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
- **AI:** OpenAI gpt-6.1-terra (replies) + gpt-6-luna (classification, lead scoring, case card, grading a reply), each falling back to the other and then to gpt-5.4-mini; chosen by the owner from the measurement in `docs/measurements/` (`measure/chosen.json` records the choice and why, including where a chosen model misses the bar that report sets). These are the built-in chains of `models.js`: the chains each job runs with are kept in the database, saved from the admin page and checked before they are saved (`model-settings.js`), and the built-in ones are used until chains are saved and whenever they cannot be read. Every model call goes through `providers.js`, which walks the chain with each model's time limit (`models.js`), the spending caps and the state of each provider; it has adapters for OpenAI, Anthropic and Google, of which only those whose key is set are used. `npm run models:upload` sends the measurements to the site, so that a chain can be checked against them
- **Case Law:** CourtListener API (NY Supreme Court, Appellate Division — no family court)
- **Database:** Neon Postgres (`@neondatabase/serverless`)
- **Payments:** Stripe (subscriptions + per-lead charges + refunds)
- **SMS:** Twilio (phone verification)
- **Email:** Nodemailer via SMTP (lead delivery, portal links, auction notifications)
- **Frontend:** Vanilla HTML/CSS/JS, glassmorphism UI — deep crimson (#9e3a5a) for personal mode, deep plum (#6e3a7c) for estate/wrongful death mode
- **Deploy:** Vercel (serverless), Cloudflare DNS + Email Routing
- **Cron:** Vercel built-in cron (the nightly job and the case library's jobs) + cron-job.org (auction closing, overdue leads)

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
| `OPENAI_API_KEY` | OpenAI API key. No setting chooses the models: they are the chains saved from the admin page, with the built-in chains of `models.js` behind them |
| `COURTLISTENER_TOKEN` | CourtListener API token (optional) |
| `LIBRARY_SEARCHES_PER_NIGHT`, `SCREEN_REQUESTS_PER_RUN`, `COURTLISTENER_RESERVE` | Optional case library limits: the topic searches a night (10), the screen's requests a run (20), and the requests left in CourtListener's day below which the library's jobs stop (30; they also stop with 5 or fewer left in the hour) |
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
| `ADMIN_SECRET` | Header secret for admin API routes. `ADMIN_SECRET_FOR_UPLOAD` is the admin secret again, in the local `.env` only, for `npm run models:upload` |
| `NOTIFICATION_EMAIL` | Operator notices: new firms, unplaced leads, declined cards, failed refunds, chat and contact-form failures, failed nightly steps, and a daily summary (`DAILY_DIGEST=off` stops the summary) |

---

## Deploy

```bash
vercel --name nycmalpractice-ai --prod
```

Set all environment variables in the Vercel dashboard. The nightly job (`/api/cron`) runs via Vercel at 7am UTC (2am ET). Each of its steps runs even if an earlier one fails; failed steps are emailed to the operator with a summary of the day. `/health/deep` answers 503 when the database cannot be reached, lacks a column the code uses, or the nightly job has not succeeded in 26 hours: point an uptime monitor at it. Its `library` and `screen` checks judge the case library's refresh and screen the same way: a failed last run, or none in 26 hours, answers 503, and a job not run yet is healthy.

**The case library's jobs:** the refresh `/api/cron/library` runs at 03:00 UTC, and the screen `/api/cron/screen` at 04:00 and 05:00 UTC (as `?run=1` and `?run=2`, which do the same work). `vercel.json` rewrites these two routes to `api/jobs.js`, the same app with a 300-second limit; every other request goes to `api/index.js`, which gets 60. Each job reads CourtListener's usage report first and stops at the reserve, counts every request it sends by job, records its run, and emails a failed step. The daily summary's Case library section gives the clear, unscreened and held decisions of each type, the decisions held for the owner, the types short of five clear decisions, the previous New York day's CourtListener requests by job (`chat-search`, `gate-lookup`, `library`, `screen`), the replies answered from the library or live, and the allowance left.

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

Source available for evaluation only. Copyright © 2026 Jerome W. Dewald, doing business as AI Strategies NYC.
All rights reserved: you may read and privately run this code to evaluate the work, and nothing else without written
permission. See [LICENSE](LICENSE).
