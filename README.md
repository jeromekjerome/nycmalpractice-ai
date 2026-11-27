# NYCMalpractice.ai

An AI intake for New York medical malpractice. A patient, or the family of a patient who died, describes what happened
in plain language. The app flags the deadlines that apply and cites real New York court decisions. If the person asks
and agrees, it sends the case to participating New York law firms, which pay to take part.

- **Demo video** (under 10 minutes): https://youtu.be/MGmXtolfXL4
- **Demo site**, with synthetic patients and firms and Stripe test cards: https://nycmalpractice-demo.vercel.app
- **Live site**, which real visitors use (please try the demo instead): https://nycmalpractice-ai.vercel.app

Jerome W. Dewald built it alone by directing AI coding agents. Most commits carry Claude's `Co-Authored-By` line. The
prototype came in March and April 2026 and the production rebuild in November 2026.

---

## Who uses it

- **Patients and families** have a free conversation. Nothing reaches a firm unless they ask for a lawyer and tick
  the consent box, which says what a firm will see and that up to three firms may contact them.
- **Participating firms** pay $199 a month. They bid in timed auctions on scored cases that show no name or contact
  details, or receive lower-scored cases directly. A firm accepts a lead only after its supervising attorney ticks
  four checks, one of them that the firm will check every cited decision in its own citator.
- **The operator** approves firms, watches the system through emails and a health check, and decides on court
  decisions the nightly screen holds and on law that has changed.

---

## For reviewers: where the production engineering is

### When a system fails

- Every model call goes through `providers.js`. Each job's chain is OpenAI's model, then Anthropic's, then Google's
  (`models.js`), each with its own time limit and under daily and monthly spending caps (`ai-budget.js`). A provider
  that stops answering is marked down and asked last, is tried again every five minutes, and the owner is emailed when
  it goes down and when it comes back (`provider-state.js`).
- If no model can answer, the visitor is asked to send the message again and still sees the deadline warnings their
  own words trigger (`server.js`, `deadlines.js`).
- CourtListener allows the app 125 requests a day. The night jobs read the usage report first and keep a reserve
  (`courtlistener-usage.js`). If CourtListener refuses a request, the job stops and leaves the item it was on untouched.
- Each failed job step is emailed to the operator (`operations.js`).
  `/health/deep` answers 503 when the database cannot be reached or a job's last run failed.

### When a court decision goes bad

- Replies cite decisions from a case library that a nightly refresh builds from CourtListener (`library-refresh.js`,
  `case-topics.js`, `case-library.js`).
- A nightly screen asks CourtListener whether a later decision cites each one with a word such as "overruled", or
  whether a higher court has ruled under the same party names (`case-screen.js`). Anything it finds holds the decision
  out of replies until the operator clears or bans it. It is a filter that errs toward holding, not a citator. More
  detail is in [The case library](#the-case-library) below.

### When the rules change

- The law the app relies on is data: `rubrics/ny_malpractice_current_law.json` holds each rule with its sources.
  Deadlines are code (`deadlines.js`), so a new deadline waits until it is written and tested.
- Every night `statute-watch.js` reads each section and bill those rules rest on from the New York Senate's Open
  Legislation API, and the State Bar's list of ethics opinions. It compares each official text with the one the owner
  approved and emails any change with the changed words marked. Nothing a visitor reads changes until the owner
  approves the new text (`npm run law:approve`).

### What the app may say

- New York State Bar Ethics Opinions 1131 and 1294 shape the wording: the notice before the visitor types, the
  consent box, "participating New York law firms", and no claim that a firm is recommended. Each requirement in the
  rules file names the files that meet it and the tests that check them (`test/requirements.test.mjs`).

### How the models were chosen

- The models were measured on this app's own conversations, and on drafts known to be wrong, before they were chosen
  (`measure/`, `docs/measurements/`). `model-watch.js` checks each month for newer models and warns before one in use
  retires.

### The demo copy

- The demo site is this code with `DEMO_MODE=1` and its own database. It sends no email or text: each one is kept in a
  public outbox. It refuses a live Stripe key and the live database. See [`demo/README.md`](demo/README.md).

---

## Run the tests

They need no settings and reach no real service: they use a placeholder database address and stand-in keys.

```bash
npm ci
npm run test:unit
npx playwright install chromium
npx playwright test
```

On every push, GitHub Actions (`.github/workflows/test.yml`) runs `npm audit`, `npm run check:shared`, the unit tests
and the browser tests. `check:shared` checks the files this app shares with its sibling, NYCInjury.ai, against the
fingerprints in `shared-code.json`.

---

## How a case reaches a firm

As the conversation develops, the small-job model scores the case from 0 to 100 on five dimensions:

| Dimension | Weight | Notes |
|---|---|---|
| Injury severity | 30% | |
| Causation clarity | 25% | How clearly the harm connects to the provider's care |
| Deadline status | 20% | 10 is well within the deadline; 1 or 2 is likely past it |
| Expert support | 15% | How likely a medical expert can support the claim |
| Damages | 10% | |

A case scoring under 55, or scored with confidence under 0.65, goes to no firm. The rest are tiered:

| Tier | Score | Reserve | How it goes to firms |
|---|---|---|---|
| Cold | 55 to 69 | $25 | Directly, to up to three firms that take the case type |
| Warm | 70 to 79 | $100 | A 2-hour auction |
| Hot | 80 to 89 | $200 | A 4-hour auction |
| Premium | 90 to 100 | $400 | A 6-hour auction |

An auction nobody wins is offered as a cold lead. A firm has 3 days to accept or decline a lead. A decline needs a
reason, and refunds follow this policy:

| Decline | Refund |
|---|---|
| Cold lead, 1st to 3rd this month | 100% |
| Cold lead, 4th or later this month | 50% |
| Auction lead, 1st this month | 50% |
| Auction lead, 2nd this month | 25% |
| Auction lead, 3rd this month | None, and 30 days out of auctions |

A lead declined for the firm's own reasons, or left unanswered, is offered to firms that have not had it.

---

## Deadlines it flags

When the visitor's own words name a kind of provider, the page shows its deadline beside the reply (`deadlines.js`).

| Claim | Law | First deadline |
|---|---|---|
| The patient's own claim | CPLR § 214-a | 2 years 6 months from the act or omission (later starts can apply, such as continuous treatment or a foreign object) |
| Against a New York City or county hospital | General Municipal Law § 50-e | A written notice of claim within 90 days |
| Against a State hospital, such as SUNY Downstate | Court of Claims Act § 10 | A claim or a notice of intention within 90 days |
| Against a federal provider (a VA or military hospital, or a community health center whose staff are deemed federal) | 28 U.S.C. § 2401(b) | A written claim to the agency within 2 years |
| Wrongful death | EPTL § 5-4.1 | 2 years from the death |

The Grieving Families Act, which would change the wrongful death rules, is not law: it was vetoed again on
December 5, 2025. The rules file lists its current bill, which the owner reviews by hand.

---

## The case library

Replies use the case library (`case-library.js`): the court decisions a nightly refresh finds on CourtListener with
each case type's topic searches (`case-topics.js`, `library-refresh.js`), each put through a nightly screen
(`case-screen.js`).

- A case type with five or more clear decisions is answered from the library: the five that share the most words with
  the conversation's search terms, the newer first on a tie. No case law search is sent while the visitor waits.
- A type with fewer searches CourtListener live, New York courts first, then a national search. The last decisions
  found for each case type are kept (`case-memory.js`) and used when the search fails.
- Either way, a decision the screen held or the owner banned is never used, and each decision shown says whether, and
  on what day, it was screened. If the library cannot be counted or picked from, the reply searches live. If the
  screen states of a live reply's decisions cannot be read, it is given none. If the library's tables have not been
  made yet, every decision is shown as not screened.
- The screen runs twice a night over the decisions due: those never screened, then those last screened 30 days ago
  or more. For each it asks CourtListener whether a later decision that cites it has one of a few words (such as
  "overruled") near its party's name. For a decision below the Court of Appeals, it also asks whether a higher court
  has since filed a decision under the same party names. A later decision the owner was already shown is not asked
  about again.
  - Nothing found: the decision is clear.
  - Anything found: it is held, left out of replies, and the owner is emailed what was found. The owner decides on the
    admin page (Decisions held): Clear, Ban, or, for a decision whose answer could not be read, Screen again.
- The gate's check of a citation against CourtListener is counted with the other requests, under `gate-lookup`.

---

## The admin page

`/admin.html`, protected by `ADMIN_SECRET` (sent as the `x-admin-secret` header):

- contact requests (read the conversation, deliver it by hand to an approved firm), auctions (cancel a stuck one),
  leads with refunds and decline reasons, and firms with their activity;
- the Models section: the chain each job runs with, which providers answer, what has been measured, and a form to
  change the order;
- the Decisions held section: what the nightly screen held, with Clear, Screen again or Ban for each;
- portal links sent by hand, a firm's active status and profile.

Firms sign in to their portal through emailed links that last 30 days; there are no passwords. A firm's phone number
is checked by text message when it registers.

---

## Tech stack

- **Backend:** Node.js and Express (ESM), on Vercel serverless functions
- **AI:** the chains in `models.js` stand behind the ones the owner saves from the admin page (`model-settings.js`).
  Replies: `gpt-6.1-terra`, then `claude-haiku-5-5`, then `gemini-3.5-flash-lite`. Small jobs (classifying,
  scoring, the case card, grading a reply): `gpt-6-luna`, then the same two. Only providers whose key is set are used.
- **Case law:** CourtListener API
- **Law:** the New York Senate's Open Legislation API, and the State Bar's list of ethics opinions
- **Database:** Neon Postgres (`@neondatabase/serverless`), its own database
- **Payments:** Stripe (the subscription, lead charges and refunds)
- **Text messages:** Twilio (the firm's phone check)
- **Email:** Nodemailer over SMTP
- **Frontend:** plain HTML, CSS and JavaScript
- **Jobs:** Vercel cron for the night jobs; cron-job.org for closing auctions and overdue leads

---

## Setup

```bash
npm install
cp .env.example .env     # then fill in the values below
npm run setup-db         # creates every table; safe to run again
npm start                # http://localhost:3003
```

## Environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string |
| `OPENAI_API_KEY` | OpenAI API key. No setting chooses the models: they are the chains saved from the admin page, with the built-in chains of `models.js` behind them |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | Optional. A provider is in the chain only if its key is set |
| `AI_DAILY_CAP_USD`, `AI_MONTHLY_CAP_USD` | The AI spending caps |
| `COURTLISTENER_TOKEN` | CourtListener API token (optional) |
| `LIBRARY_SEARCHES_PER_NIGHT`, `SCREEN_REQUESTS_PER_RUN`, `COURTLISTENER_RESERVE` | Optional case library limits: the topic searches a night (10), the screen's requests a run (20), and the requests left in CourtListener's day below which the library's jobs stop (30; they also stop with 5 or fewer left in the hour) |
| `NYSENATE_API_KEY` | The Senate's Open Legislation API key, for the statute watch |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_ID` | Stripe price ID for the $199/month subscription |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Twilio outbound phone number |
| `SMTP_HOST` | SMTP server host |
| `SMTP_PORT` | SMTP port (default: 465) |
| `SMTP_USER` | SMTP username and from address |
| `SMTP_PASS` | SMTP password |
| `APP_URL` | The site's public address (e.g. `https://nycmalpractice-ai.vercel.app`) |
| `CRON_SECRET` | Bearer token for the job routes |
| `ADMIN_SECRET` | Header secret for the admin routes. `ADMIN_SECRET_FOR_UPLOAD` is the admin secret again, in the local `.env` only, for `npm run models:upload` |
| `NOTIFICATION_EMAIL` | Operator notices: new firms, unplaced leads, declined cards, failed refunds, chat and contact-form failures, failed job steps, and a daily summary (`DAILY_DIGEST=off` stops the summary) |
| `BACKUP_*` | Optional encrypted database backups to S3-compatible storage (see `.env.example`) |
| `DEMO_MODE` | `1` only on the demo copy (see `demo/README.md`) |

## Deploy

```bash
vercel --name nycmalpractice-ai --prod
```

Set the environment variables in the Vercel dashboard. Vercel cron runs the night jobs (`vercel.json`, times in UTC):

| Job | Route | Time |
|---|---|---|
| Case library refresh | `/api/cron/library` | 03:00 |
| Case library screen | `/api/cron/screen?run=1`, `?run=2` | 04:00, 05:00 |
| Statute watch | `/api/cron/statute-watch` | 06:00 |
| Nightly job | `/api/cron` | 07:00 |

`vercel.json` sends the library's two routes to `api/jobs.js`, the same app with a 300-second limit; every other
request goes to `api/index.js`, which gets 60. Each step of the nightly job runs even if an earlier one fails. Point an
uptime monitor at `/health/deep`: it answers 503 when the database cannot be reached, lacks a column the code uses,
or a job has failed or not succeeded in 26 hours. A job not run yet counts as healthy.

Two more jobs run on cron-job.org, each with the header `Authorization: Bearer <CRON_SECRET>`:

| Job | Route | Schedule |
|---|---|---|
| Close auctions | `<APP_URL>/api/cron/close-auctions` | Every 5 minutes |
| Overdue leads | `<APP_URL>/api/cron/overdue-leads` | Every hour |

Register the Stripe webhook at `<APP_URL>/api/webhooks/stripe` with `checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid` and
`customer.updated`.

---

## License

Source available for evaluation only. Copyright © 2026 Jerome W. Dewald, doing business as AI Strategies NYC.
All rights reserved: you may read and privately run this code to evaluate the work, and nothing else without written
permission. See [LICENSE](LICENSE).
