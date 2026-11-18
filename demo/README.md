# The demo copy

A second deployment of this app that runs on **synthetic data only**, so the whole marketplace can be shown end to
end: a patient or family describes what happened, the AI answers with real New York case law, the conversation is
scored, a lead is auctioned to law firms or sent to them directly, and a firm bids, wins, reviews and accepts it.

Nothing in it can reach a real person:

- Every patient, family member, firm and attorney in `synthetic-data.mjs` is invented. Phone numbers are in
  555-0100 to 555-0199 (reserved for fiction), email addresses use `.example` domains (which can never be
  registered), and attorney registration numbers read `DEMO-nnnn`.
- With `DEMO_MODE=1` the app sends no email and no text. Each one is kept in the demo outbox at `/demo/outbox`,
  where its links (sign-in, auction, lead) can be followed.
- With `DEMO_MODE=1` the app refuses a live Stripe key. Charges use Stripe's test cards.
- Every page shows a banner saying it is the demo, and asks visitors not to enter real information.
- The demo is kept out of search results (`X-Robots-Tag: noindex`; blog pages name the live site as canonical),
  and only the live site reports to analytics.
- Case law comes from CourtListener and laws from public statutes: real, public data.

## Settings for the demo deployment

| Setting | Value |
|---|---|
| `DEMO_MODE` | `1` |
| `DATABASE_URL` | the demo database, never the live one |
| `APP_URL` | the demo's own address |
| `CANONICAL_URL` | the live site, `https://nycmalpractice-ai.vercel.app` |
| `STRIPE_SECRET_KEY` | a Stripe **test** key (`sk_test_...`) |
| `OPENAI_API_KEY`, `COURTLISTENER_TOKEN` | as for the live site |
| `ADMIN_SECRET` | its own, for the demo's admin page |
| `AI_DAILY_CAP_USD` | a low cap, e.g. `3` |
| `DAILY_DIGEST` | `off` |

Leave `SMTP_*`, `TWILIO_*`, `CRON_SECRET` and the backup settings unset.

## Filling it

```
DEMO_DATABASE_URL=postgres://...demo...  STRIPE_SECRET_KEY=sk_test_...  DEMO_APP_URL=https://<demo address>  node demo/seed.mjs
```

The seed writes only to `DEMO_DATABASE_URL`. It refuses the live database, refuses a database that has data and is
not marked as the demo, and refuses a live Stripe key. `--reset` empties a demo database and seeds it again. It
prints a sign-in link for every firm's portal.

What it creates: eight firms (ready, awaiting approval, suspended, card declining, sign-up unfinished); auctions
that are open, closing within 15 minutes, won and charged, and unbid and re-offered as cold leads; leads that are
pending, accepted with the supervising attorney's checks, and declined with a refund; a request waiting for the
operator; and a conversation scored as not a case because its deadline passed.

## New visitors, live

```
node demo/run-personas.mjs https://<demo address> [persona keys] [--pace=65]
```

Sends the `PERSONAS` in `synthetic-data.mjs` to the demo's real chat one message at a time, then sends each contact
form. The live AI replies, scores and routes each lead. It runs only against a site whose `/api/site-mode` says it
is the demo. `--pace` is the wait between messages in seconds; CourtListener allows 5 calls a minute.

## Closing an auction early

```
DEMO_DATABASE_URL=postgres://...demo...  node demo/fast-forward.mjs <auction number>
```

A hot auction runs four hours. This moves one open auction's closing time into the past, so the next request to the
demo site closes it: the leading firm's test card is charged and the lead is delivered, as when an auction runs out
on its own. It changes that one row and nothing else, only in a database the seed has marked as the demo, and it
refuses the live database.
