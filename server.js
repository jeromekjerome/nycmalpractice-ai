// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import 'dotenv/config';
import express from 'express';
import { securityHeaders } from './security-headers.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { neon } from '@neondatabase/serverless';
import { answerUserQuestion, noticeForReply } from './ask.js';
import { closeExpiredAuctions, createAuction, deliverColdLead, getAuctionStatus, placeBid, acceptLead, declineLead, notifyOperatorOfContactRequest, notifyOperator, sendOperatorNotice, TIER_CONFIG, DECLINE_REASONS, deliverLeadByHand, remindClosingAuctions, openAuctionsFor, portalAuctionLink } from './auction.js';
import { registerFirm, sendVerificationCode, verifyPhoneCode, validateToken, updateFirmSubscription, getFirm, updateFirmProfile, createMagicLink, VerificationLimitError, recentDeclineCounts, linkOpensAuction, linkOpensLead, linkOpensAccount, approveFirm, setSubscriptionStatus, ensureStripeCustomer, changeUnverifiedPhone, setCustomerCard, findFirmByEmail } from './firms.js';
import { rateLimit } from './rate-limit.js';
import { alertOperatorOnce, tellOwnerOfProviders, tellOwnerOfModelChains, recordInteraction, deepHealth, runSteps, recordJobRun, reportFailedSteps, sendDailyDigest } from './operations.js';
import nodemailer from 'nodemailer';
import { createSubscriptionCheckout, createPortalSession, constructWebhookEvent, getSubscriptionDetails, getCustomerCard, liveSubscription } from './stripe.js';
import { runJob, replyClock, MIN_TIME_LEFT_MS, configureProviders, withoutKeys, providerPing, providerStates, adaptersFor } from './providers.js';
import { modelWatch } from './model-watch.js';
import { statuteWatch } from './statute-watch.js';
import { refreshLibrary } from './library-refresh.js';
import { heldDecisions, decideHeld, screenStates, shownScreen } from './case-library.js';
import { screenDecisions } from './case-screen.js';
import { CASE_TOPICS } from './case-topics.js';
import { searchTopic, lookupCitations, searchForScreen } from './courtlistener.js';
import { readAllowance } from './courtlistener-usage.js';
import { sourceReader } from './statute-text.js';
import { readLawFile, snapshotReader } from './law-file.js';
import { CURRENT_LAW_FILE, STATUTE_TEXTS_DIR, SITE_NAME } from './gate-config.js';
import { providerState } from './provider-state.js';
import { configureModelSettings, chains, measurements, saveChains, recordMeasurements, checkMeasurementRows, KEY_NAMES } from './model-settings.js';
import { MODELS } from './model-registry.js';
import { DEFAULTS, limitFor, DEFAULT_ASK_REPLY_DEADLINE_MS, replyReserveMs } from './models.js';
import { APP_URL, APP_ID, CONTACT_CONSENT_TEXT, CONTACT_FORM_FROM_STEP, PRIVACY_PROVIDER_ORDER } from './site.js';
import { mentionsPublicHospital, deadlineNotices } from './deadlines.js';
import { buildSummaryEmail } from './summary.js';
import { toPublicEvaluation, isHitlVerificationComplete, HITL_ATTESTATION_KEYS, loadRubric, loadCurrentLawNotes } from './gatekeeper.js';
import blogApp from './blog-server.js';
import { isDemo, demoMailer, outboxMessages, outboxPage } from './demo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const sql = neon(process.env.DATABASE_URL);

// The chains each job runs with are a setting kept in this database (model-settings.js), with the built-in chains of
// models.js behind it; the measurements that a save is checked against are this app's own. The owner is told
// (operations.js), once a day, when the saved chains name a model the registry no longer has.
// No saved chain may ask the AI providers in another order than the privacy page states (site.js).
configureModelSettings({ sqlClient: sql, app: APP_ID, tell: tellOwnerOfModelChains, providerOrder: PRIVACY_PROVIDER_ORDER });

// A provider's ping is a health check of its main model in the chains in use when it is sent (providerPing). The
// provider state hands it a signal, which the reply fires when the check's answer no longer matters; it goes on to the
// health check, which is then cut off at once. Exported for the tests.
export async function pingProvider(provider, { signal = null } = {}) {
  const { answer, small } = await chains();
  return providerPing([answer, small])(provider, { signal });
}

// Whether each AI provider is answering, kept in this database for every server instance (provider-state.js). A
// reply that fails on a provider sends it one ping, through the spending caps. The owner is told (operations.js) once
// when a provider is marked down and once when it comes back, and once an hour for each provider that refuses a
// request the app sent it. providers.js asks the state before a reply's jobs and tells it how each reply went.
const stateOfProviders = providerState({ sqlClient: sql, ping: pingProvider, tell: tellOwnerOfProviders });
configureProviders({ tell: tellOwnerOfProviders, state: stateOfProviders });
// What /health/models shows before its first check: the built-in chains. Each check pings the chains in use.
let modelHealthSnapshot = {
  answer: { active: DEFAULTS.answer[0] || null, fallbacks_available: DEFAULTS.answer.slice(1) },
  aux: { active: DEFAULTS.small[0] || null, fallbacks_available: DEFAULTS.small.slice(1) },
  embedding: { active: DEFAULTS.embedding[0] || null, fallbacks_available: DEFAULTS.embedding.slice(1) },
};
const MODEL_HEALTH_TTL_MS = Number.parseInt(process.env.MODEL_HEALTH_TTL_MS || '60000', 10);
let modelHealthLastCheckedAt = 0;
let modelHealthRefreshPromise = null;

// Standard browser protections on every response (security-headers.js). The API no longer answers other
// websites: the open CORS policy let any site call it, and the pages call it from this site.
app.use(securityHeaders);
// The demo copy (demo.js) is kept out of search results; its pages name the live site as the original.
app.use((_req, res, next) => { if (isDemo()) res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use(blogApp);

// ─── Work a reply must not leave behind ───────────────────────────────────────
// A serverless function is suspended as soon as its response is sent, so work still running at
// that point is lost: on Vercel the conversation was never saved, and a lead hand-off started the
// same way would stop part-way. This work is therefore finished before the reply goes out.
// One time budget per reply covers all of it, so a slow mail server or payment call cannot hold
// the reply: work that outlasts the budget is logged, because on a serverless host it may not
// complete.
const DEFAULT_FOLLOW_UP_WORK_CAP_MS = 20_000;

function followUpDeadline() {
  return Date.now() + (Number(process.env.ASK_FOLLOW_UP_WORK_CAP_MS) || DEFAULT_FOLLOW_UP_WORK_CAP_MS);
}

async function finishBeforeReply(label, work, deadline) {
  // The failure handler is attached at once, so a rejection after the deadline is never unhandled.
  const settled = Promise.resolve(work).then(
    () => 'done',
    (err) => { console.error(`[ask] ${label} failed:`, err?.message || err); return 'failed'; },
  );
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), 'timed out'); });
  const outcome = await Promise.race([settled, timedOut]);
  clearTimeout(timer);
  if (outcome === 'timed out') {
    console.error(`[ask] ${label} was still running when the reply was due; replying without waiting for it`);
  }
  return outcome;
}

// The longest a visitor waits for a reply (DEFAULT_ASK_REPLY_DEADLINE_MS in models.js, 45 seconds, unless
// ASK_REPLY_DEADLINE_MS says otherwise). Past it the page is told to send the message again, and keeps it in the
// box; the host used to cut the request off with its own error page, and the question was lost. The work after
// the reply (saving the conversation, closing auctions) must also end within REQUEST_BUDGET_MS of the request's
// start, inside the host's 60-second limit; each step used to get 20 seconds of its own, so a slow reply could
// run to 80.
const REQUEST_BUDGET_MS = 57_000;
const SLOW_REPLY = 'This is taking longer than usual, and your message was not answered. It is still in the box below: please send it again.';

const AI_NOT_ANSWERING = 'The AI service is not answering just now, and your message was not answered. It is still in the box below: please send it again in a minute.';

// The work's result, or null if it is not done in time. A failure that comes after the deadline is only logged.
function withinDeadline(work, ms) {
  let timer;
  let late = false;
  const deadline = new Promise(resolve => { timer = setTimeout(() => { late = true; resolve(null); }, ms); });
  work.catch(err => { if (late) console.error('[ask] a reply that missed its deadline then failed:', err?.message || err); });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

// A failure is logged in full; the caller gets a plain message, never the internal error text.
function serverError(req, res, err) {
  console.error(`Error in ${req.method} ${req.path}:`, err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// The Stripe events that can change whether a firm's subscription is paid up.
const SUBSCRIPTION_EVENTS = new Set(['customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed', 'invoice.paid']);

// A webhook that fails Stripe's signature check is refused without saying why.
function refuseWebhook(res, err) {
  console.warn('Stripe webhook refused:', err.message);
  return res.status(400).send('Webhook signature verification failed');
}

// ─── AI Chat ──────────────────────────────────────────────────────────────────
// Per-client limits on the endpoints that cost money or send messages (see rate-limit.js).
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const limitChat     = rateLimit('ask', [[20, 10 * MINUTE], [150, 24 * HOUR]], 'You have sent a lot of messages in a short time. Please wait a few minutes and try again.');
const limitContact  = rateLimit('contact', [[5, HOUR]]);
const limitSummary  = rateLimit('summary', [[3, HOUR], [5, 24 * HOUR]], 'Too many summary requests. Please wait before trying again.');
const limitSignup   = rateLimit('firm-signup', [[5, HOUR]]);
const limitTexts    = rateLimit('firm-texts', [[5, HOUR]]);
const limitVerify   = rateLimit('firm-verify', [[20, HOUR]]);
const limitEmails   = rateLimit('firm-emails', [[5, HOUR]]);

// The registration steps after the first prove they belong to that registration with the token it
// returned. A firm number alone is not enough: it is small, sequential and easy to guess.
async function ownsRegistration(token, firmId) {
  if (typeof token !== 'string' || !token) return false;
  const tokenData = await validateToken(token);
  return !!tokenData && linkOpensAccount(tokenData) && String(tokenData.firm_id) === String(firmId);
}
const WRONG_AUCTION = 'This link is for a different auction.';
const WRONG_LEAD    = 'This link is for a different lead.';
const ACCOUNT_ONLY  = 'Open your account from the sign-in link in your Firm Login email.';
const REGISTRATION_EXPIRED = 'This registration session has expired. Use Firm Login to get a sign-in link by email.';

// The longest message the chat accepts. Each message goes to several model calls.
const MAX_QUESTION_CHARS = 4000;

// The conversation so far, from the server's own record. A history sent with the request is never trusted:
// it could be invented, and the stored one is what gets scored and, with consent, sent to law firms.
async function loadStoredHistory(sessionId, mode) {
  const [row] = await sql`SELECT mode, history FROM conversations WHERE session_id = ${sessionId} LIMIT 1`;
  if (!row || row.mode !== mode || !Array.isArray(row.history)) return [];
  return row.history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
}

// Used only when the stored record cannot be read: what the page sent, limited to visitor and AI messages.
function cleanClientHistory(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-40)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION_CHARS) }));
}

// Auctions last 2 to 6 hours, but scheduled jobs run only once a day on this hosting plan. So requests from
// firms and visitors also close any auction past its time, at most once a minute per server instance, and
// the winner is charged and gets the lead soon after the auction ends. The same sweep sends each auction's
// closing-soon reminder (remindClosingAuctions).
let lastAuctionSweep = 0;
function sweepExpiredAuctions() {
  const inTests = process.env.NODE_ENV === 'test';
  if (inTests && process.env.AUCTION_SWEEP_IN_TESTS !== '1') return Promise.resolve(0);
  if (!inTests && Date.now() - lastAuctionSweep < 60_000) return Promise.resolve(0);
  lastAuctionSweep = Date.now();
  const reminders = remindClosingAuctions().catch(err => { console.error('Sending closing reminders failed:', err.message); return 0; });
  const closing = closeExpiredAuctions().catch(err => { console.error('Closing expired auctions failed:', err.message); return 0; });
  return Promise.all([closing, reminders]).then(([closed]) => closed);
}

app.post('/api/ask', limitChat, async (req, res) => {
  const { question, sessionId } = req.body;
  const mode = req.body.mode === 'estate' ? 'estate' : 'personal';
  if (!question?.trim() || !sessionId) return res.status(400).json({ error: 'question and sessionId required' });
  if (typeof question !== 'string' || typeof sessionId !== 'string' || sessionId.length > 100) {
    return res.status(400).json({ error: 'question and sessionId required' });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return res.status(400).json({ error: `Please keep your message under ${MAX_QUESTION_CHARS.toLocaleString('en-US')} characters.` });
  }
  const requestStart = Date.now();
  const finishBy = () => Math.min(followUpDeadline(), requestStart + REQUEST_BUDGET_MS);
  const closingAuctions = sweepExpiredAuctions();

  // One clock for the whole reply, from the request's start: each model call of the reply is given its own
  // limit, or what is left of the clock if that is less, and a provider that fails once in the reply goes last
  // for the rest of it (providers.js). The clock ends its reserve before the deadline, so that a step of the gate
  // cut off at the clock's end still leaves the gate time to grade the drafted reply by code. withinDeadline
  // keeps the full deadline, for the work that is no model call.
  const replyDeadlineMs = Number(process.env.ASK_REPLY_DEADLINE_MS) || DEFAULT_ASK_REPLY_DEADLINE_MS;
  const clock = replyClock({ deadlineAt: requestStart + replyDeadlineMs - replyReserveMs(replyDeadlineMs), limitFor });

  let history;
  let historyTrusted = true;
  let databaseAlert = null;
  try {
    history = await loadStoredHistory(sessionId, mode);
  } catch (err) {
    // The record could not be read. The reply still uses what the page sent, cleaned up, but nothing from
    // this turn is scored or saved, since that history cannot be checked. The site looks healthy meanwhile,
    // so the operator is told.
    console.error('Could not read the stored conversation:', err.message);
    history = cleanClientHistory(req.body.history);
    historyTrusted = false;
    databaseAlert = alertOperatorOnce('database-read', 30 * MINUTE, 'NYCMalpractice.ai cannot read its database',
      `<p>The chat could not read a stored conversation: ${escapeHtml(err.message)}.</p><p>Replies still go out, but no lead can be scored or saved, and contact requests fail. You will not be emailed about this again for 30 minutes.</p>`);
  }
  // Every message is recorded with how it ended; a run of failures tells the operator (operations.js).
  const record = (outcome, extra = {}) => recordInteraction({ sessionId, question, mode, outcome, latencyMs: Date.now() - requestStart, ...extra });
  // A reply nobody could give (too slow, no model answering, a spending cap reached) is always answered the same
  // way: a 503 that asks the visitor to send the message again, with the deadline notices their own words already
  // trigger (deadlines.js reads the words alone, in either mode). The page shows them, as it does for a reply.
  const unanswered = (error, extra = {}) => ({
    error, ...extra, retry: true,
    deadlineNotices: deadlineNotices([...history, { role: 'user', content: question }]),
  });
  const beforeReply = async () => {
    await finishBeforeReply('closing expired auctions', closingAuctions, finishBy());
    if (databaseAlert) await finishBeforeReply('the database alert', databaseAlert, finishBy());
    // The reply is over: the provider state is told how it went for each provider (providers.js), with the check of a
    // provider and the email that can follow (provider-state.js).
    await finishBeforeReply('the provider state', clock.end(), finishBy());
  };

  try {
    const answering = answerUserQuestion({ question, mode, sessionId, history, allowLeadScoring: historyTrusted, clock }).catch(err => {
      // The reply's own call was cut off at the deadline, or there was no time left to make it: a reply that
      // missed its deadline, which the visitor is asked to send again.
      if (err?.code === 'ai_unavailable' && clock.remaining() < MIN_TIME_LEFT_MS) {
        console.error('[ask] the reply ran out of time:', err.message);
        return null;
      }
      throw err;
    });
    const result = await withinDeadline(answering, replyDeadlineMs);
    if (!result) {
      // Nothing from this turn is saved, so the visitor can simply send it again.
      console.error('[ask] no reply in time; the visitor was asked to send the message again');
      await finishBeforeReply('recording the message', record('slow'), finishBy());
      await beforeReply();
      return res.status(503).json(unanswered(SLOW_REPLY));
    }

    await record('ok', { caseType: result.caseType, gateStatus: result.evaluation?.gate_status || null });

    const updatedHistory = [...history, { role: 'user', content: question }, { role: 'assistant', content: result.answer }];
    // A qualifying lead score is kept with the conversation. The lead goes to firms only from
    // /api/contact, once the visitor has given contact details and agreed to be contacted. A rejection clears an
    // earlier score; no verdict (an error or a timeout) leaves it as it was. The score is kept with when it was given
    // and which provider and model gave it (scoredBy), which the firms' pages and emails, and the visitor, are not
    // shown: they are given the score's fields by name.
    const verdict = result.leadScore;
    const leadScore = verdict?.tier ? { ...verdict, scoredAt: new Date().toISOString() } : null;
    const clearLeadScore = verdict?.viable === false;
    if (historyTrusted) {
      await finishBeforeReply('saving the conversation', upsertConversation(sessionId, mode, result.caseType, updatedHistory, leadScore, result.evaluation || null, { clearLeadScore }), finishBy());
    }

    await beforeReply();
    res.json({
      answer: result.answer, cases: result.cases || [], caseNotice: result.caseNotice || null, caseType: result.caseType || null,
      caseAnalysis: result.caseAnalysis || null, leadTier: result.leadScore?.tier || null,
      // The gate's verdict on the reply above. Drafts the gate blocked are not sent to the browser.
      evaluation: toPublicEvaluation(result.evaluation),
      // From the referral step on, the page offers the contact form.
      contactForm: result.turn >= CONTACT_FORM_FROM_STEP,
      // Deadlines shorter than the usual one that the visitor's words point to (deadlines.js): a public hospital's
      // 90-day notice, or a federal provider's 2-year claim. deadlineNotice is kept for pages loaded before this.
      deadlineNotices: deadlineNotices(updatedHistory),
      deadlineNotice: mentionsPublicHospital(updatedHistory) ? 'public_hospital' : null,
    });
  } catch (err) {
    // A 400 that every provider answered carries the provider's own words, which can quote a key: one cleaned, cut line.
    if (err?.allRefused === true) console.error(`Error in /api/ask: every AI provider refused the request (${err.status ?? 400}): ${withoutKeys(err.message).slice(0, 300)}`);
    else console.error('Error in /api/ask:', err);
    await finishBeforeReply('recording the message', record('error'), finishBy());
    // An auction being closed alongside this message is finished first: once the reply is sent the function
    // may be suspended, leaving the auction part-way through.
    await beforeReply();
    if (err.code === 'ai_budget_exceeded' || err.code === 'ai_budget_unavailable') {
      return res.status(503).json(unanswered(err.code === 'ai_budget_exceeded'
        ? 'The AI service has reached its spending limit. Please try again later.'
        : 'The AI service is temporarily unavailable. Please try again later.', { code: err.code }));
    }
    // Every model of a chain failed, and the reply still had time: the service is not answering.
    // So does a request every provider refused as malformed (providers.js marks that error): nothing could answer.
    if (err.code === 'ai_unavailable' || err.allRefused === true) return res.status(503).json(unanswered(AI_NOT_ANSWERING));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Conversation History ─────────────────────────────────────────────────────
const visitorMessages = history => (Array.isArray(history) ? history.filter(message => message?.role === 'user').length : 0);

app.get('/api/conversations/:sessionId', async (req, res) => {
  try {
    // What the page needs to restore the conversation. The name and phone number are not sent back:
    // the page never shows them again, and they are not needed to continue.
    const [conv] = await sql`SELECT session_id, mode, case_type, history, contact_consent_at, updated_at FROM conversations WHERE session_id = ${req.params.sessionId} LIMIT 1`;
    if (!conv) return res.json({ history: [] });
    res.json({
      ...conv,
      deadlineNotices: deadlineNotices(conv.history),
      deadlineNotice: mentionsPublicHospital(conv.history) ? 'public_hospital' : null,
      // The contact form comes back if it was offered (from the referral step) and not yet sent.
      contactForm: !conv.contact_consent_at && visitorMessages(conv.history) >= CONTACT_FORM_FROM_STEP,
    });
  } catch (err) {
    console.error('Error in /api/conversations:', err);
    res.status(500).json({ error: 'The conversation could not be loaded.' });
  }
});

app.post('/api/summary', limitSummary, async (req, res) => {
  const { sessionId, email } = req.body || {};
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return res.status(400).json({ error: 'sessionId required' });
  if (cleanEmail.length > 254 || !/^[^\s@<>"'()]+@[^\s@<>"'()]+\.[A-Za-z]{2,}$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  try {
    const [conv] = await sql`SELECT mode, case_type, history, lead_score FROM conversations WHERE session_id = ${sessionId} LIMIT 1`;
    if (!conv) return res.status(404).json({ error: 'We could not find an assessment to send. Please send a message first.' });
    const message = buildSummaryEmail(conv, deadlineNotices(conv.history));
    const transporter = getTransporter();
    if (!transporter) console.log('[EMAIL MOCK] Case summary sent');
    else await transporter.sendMail({ from: process.env.SMTP_USER, to: cleanEmail, ...message });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /api/summary:', err);
    res.status(500).json({ error: 'The summary could not be sent. Please try again.' });
  }
});

// ─── Contact request ──────────────────────────────────────────────────────────
// A lead goes to law firms only from here: once the visitor has given a name and phone number in the
// contact form and agreed to the consent text. The lead carries those details, so the firm that takes
// it can reach the visitor.
app.post('/api/contact', limitContact, async (req, res) => {
  const { sessionId, name, phone, bestTime, email, consent } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  const digits    = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  const cleanTime = typeof bestTime === 'string' ? bestTime.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
  if (typeof sessionId !== 'string' || !sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (cleanName.length < 2 || cleanName.length > 100) return res.status(400).json({ error: 'Please enter your name.' });
  if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) return res.status(400).json({ error: 'Please enter a 10-digit phone number.' });
  // Optional: used to tell the client which firm accepted.
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  if (cleanEmail && (cleanEmail.length > 254 || !/^[^\s@<>"'()]+@[^\s@<>"'()]+\.[A-Za-z]{2,}$/.test(cleanEmail))) {
    return res.status(400).json({ error: 'Please enter a valid email address, or leave it blank.' });
  }
  if (consent !== true) return res.status(400).json({ error: 'Please check the box to agree to be contacted.' });

  try {
    const [conv] = await sql`SELECT mode, case_type, history, lead_score, gate_audit FROM conversations WHERE session_id = ${sessionId} LIMIT 1`;
    if (!conv) return res.status(404).json({ error: 'We could not find your conversation. Please send a message first.' });

    const phoneNumber = digits.slice(-10);
    const [saved] = await sql`
      UPDATE conversations
      SET name = ${cleanName}, phone = ${phoneNumber}, best_time = ${cleanTime || null}, email = ${cleanEmail || null},
          contact_consent_at = NOW(), contact_consent_text = ${CONTACT_CONSENT_TEXT}, updated_at = NOW()
      WHERE session_id = ${sessionId}
      RETURNING contact_consent_at`;

    const score = conv.lead_score;
    if (score?.tier) {
      // Claimed on the conversation itself, so a second submission (a retry, a second tab) sends nothing more.
      // The old check read a log row that might not exist, and two submissions at once could both pass it.
      const [claimed] = await sql`UPDATE conversations SET lead_sent_at = NOW() WHERE session_id = ${sessionId} AND lead_sent_at IS NULL RETURNING session_id`;
      if (claimed) {
        const leadData = leadDataFrom(conv, { name: cleanName, phone: phoneNumber, email: cleanEmail || null, bestTime: cleanTime || null, consentedAt: saved?.contact_consent_at || null, consentText: CONTACT_CONSENT_TEXT });
        const handOff = score.tier === 'cold'
          ? deliverColdLead(sessionId, conv.case_type, score, leadData)
          : createAuction(sessionId, conv.case_type, score, leadData);
        const outcome = await finishBeforeReply('lead hand-off', handOff, followUpDeadline());
        // A hand-off that failed outright is released, so asking again can send it; one still running is not.
        if (outcome === 'failed') await sql`UPDATE conversations SET lead_sent_at = NULL WHERE session_id = ${sessionId}`;
      }
    } else {
      await finishBeforeReply('contact request notice', notifyOperatorOfContactRequest(conv.case_type, conv.mode), followUpDeadline());
    }
    res.json({ ok: true, caseType: conv.case_type || null, leadTier: score?.tier || null });
  } catch (err) {
    console.error('Error in /api/contact:', err);
    // A client who asked to be contacted may be lost: the operator is told at once, without the client's details.
    await finishBeforeReply('the contact failure notice', alertOperatorOnce('contact-failed', 10 * MINUTE, 'NYCMalpractice.ai: a contact request failed',
      `<p>A visitor's request to be contacted could not be completed: ${escapeHtml(err.message)}.</p><p>They were asked to try again; what they typed may not have been saved. The admin page lists the requests that were. You will not be emailed about this again for 10 minutes.</p>`),
      followUpDeadline());
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Firm Registration ────────────────────────────────────────────────────────
// Firm sign-up fields are later shown on the admin page: plain text of a sensible length. A firm name
// never needs angle brackets, so they are refused outright.
function signupProblem({ name, email, phone, attorneyName, attorneyRegistration, termsAccepted }) {
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (cleanName.length < 2 || cleanName.length > 120 || /[<>\u0000-\u001f\u007f]/.test(cleanName)) return 'Please enter the firm name (up to 120 characters).';
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  if (cleanEmail.length > 254 || !/^[^\s@<>"'()]+@[^\s@<>"'()]+\.[A-Za-z]{2,}$/.test(cleanEmail)) return 'Please enter a valid email address.';
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  if (digits.length < 10 || digits.length > 15) return 'Please enter a valid phone number.';
  const attorney = typeof attorneyName === 'string' ? attorneyName.trim() : '';
  if (attorney.length < 2 || attorney.length > 100 || /[<>\u0000-\u001f\u007f]/.test(attorney)) return "Please enter the supervising attorney's name.";
  if (!/^\d{6,8}$/.test(registrationNumber(attorneyRegistration))) return "Please enter the supervising attorney's New York registration number (7 digits).";
  if (termsAccepted !== true && termsAccepted !== 'true') return 'You must agree to the Terms of Service to register.';
  return null;
}

// New York attorney registration numbers are 7 digits; spaces and dashes typed with them are dropped.
const registrationNumber = value => (typeof value === 'string' ? value.replace(/[\s-]/g, '') : '');

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

app.post('/api/firms/register', limitSignup, async (req, res) => {
  const { name, email, phone, attorneyName, attorneyRegistration, termsAccepted } = req.body;
  if (!name || !email || !phone) return res.status(400).json({ error: 'name, email, phone required' });
  const problem = signupProblem({ name, email, phone, attorneyName, attorneyRegistration, termsAccepted });
  if (problem) return res.status(400).json({ error: problem });
  try {
    const { firm, isNew } = await registerFirm({
      name, email, phone, attorneyName: attorneyName.trim(), attorneyRegistration: registrationNumber(attorneyRegistration), termsAccepted: true,
    });
    if (!isNew) {
      // An existing firm signs in through the link emailed to it, never through this form: otherwise
      // anyone who knew a firm's email could change its profile or billing. The page offers to email the link.
      return res.status(409).json({ error: 'This email is already registered. Use Firm Login to get a sign-in link by email.', signIn: true });
    }
    // The firm exists from here on, so a text that cannot be sent is a notice, not a failure: a failure used to
    // leave a firm that could neither finish sign-up nor register again.
    let notice = null;
    let textProblem = null;
    try { await sendVerificationCode(firm.id); }
    catch (err) {
      if (err instanceof VerificationLimitError) notice = err.message;
      else {
        console.error(`The verification text for new firm ${firm.id} failed:`, err.message);
        textProblem = err.message;
        notice = 'We could not text a code to that number. Check that it is a mobile number, or change it below, then send a new code.';
      }
    }
    const registrationToken = await createMagicLink(firm.id, { expiresInHours: 6 });
    // The operator checks the attorney's registration and approves the firm before it gets any lead.
    await notifyOperator(`New firm awaiting approval: ${firm.name}`,
      `<p>${escapeHtml(firm.name)} (${escapeHtml(firm.email)}) has registered. Supervising attorney: ${escapeHtml(firm.attorney_name)}, ` +
      `New York registration number ${escapeHtml(firm.attorney_registration)}.</p>` +
      `<p>Check the registration in the <a href="https://iapps.courts.state.ny.us/attorneyservices/search?0">New York attorney search</a>, ` +
      `then approve the firm on the admin page. It gets no leads until then.</p>` +
      (textProblem ? `<p>The verification text to ${escapeHtml(firm.phone)} could not be sent: ${escapeHtml(textProblem)}</p>` : ''));
    res.json({ firmId: firm.id, isNew, phoneVerified: firm.phone_verified, registrationToken, ...(notice ? { notice } : {}) });
  } catch (err) {
    console.error('Error in /api/firms/register:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/firms/verify-phone', limitVerify, async (req, res) => {
  const { firmId, code, token } = req.body;
  if (!firmId || !code) return res.status(400).json({ error: 'firmId and code required' });
  if (!(await ownsRegistration(token, firmId))) return res.status(401).json({ error: REGISTRATION_EXPIRED });
  res.json({ ok: await verifyPhoneCode(firmId, code) });
});

app.put('/api/firms/:id/profile', async (req, res) => {
  const { specializations, serviceArea, contactName, token } = req.body;
  if (!(await ownsRegistration(token, req.params.id))) return res.status(401).json({ error: REGISTRATION_EXPIRED });
  try {
    await updateFirmProfile(req.params.id, { specializations, serviceArea, contactName });
    res.json({ ok: true });
  } catch (err) { serverError(req, res, err); }
});

app.post('/api/firms/resend-code', limitTexts, async (req, res) => {
  const { firmId, token } = req.body;
  if (!firmId) return res.status(400).json({ error: 'firmId required' });
  if (!(await ownsRegistration(token, firmId))) return res.status(401).json({ error: REGISTRATION_EXPIRED });
  try {
    await sendVerificationCode(firmId);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof VerificationLimitError) return res.status(429).json({ error: err.message });
    console.error('Error in /api/firms/resend-code:', err);
    res.status(500).json({ error: 'The code could not be sent. Please try again.' });
  }
});

// A firm that typed a wrong number, or a landline, corrects it and gets a new code, from sign-up or its portal.
app.post('/api/firms/phone', limitTexts, async (req, res) => {
  const { firmId, token, phone } = req.body;
  if (!firmId) return res.status(400).json({ error: 'firmId required' });
  if (!(await ownsRegistration(token, firmId))) return res.status(401).json({ error: REGISTRATION_EXPIRED });
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  if (digits.length < 10 || digits.length > 15) return res.status(400).json({ error: 'Please enter a valid phone number.' });
  let changed = null;
  try {
    changed = await changeUnverifiedPhone(firmId, phone);
    if (!changed) return res.status(409).json({ error: 'Your phone number is already verified.' });
    await sendVerificationCode(firmId);
    res.json({ ok: true, phone: changed.phone });
  } catch (err) {
    // The number may have changed even though no code went out; the page shows the number now on file.
    const saved = changed ? { phone: changed.phone } : {};
    if (err instanceof VerificationLimitError) return res.status(429).json({ error: `Your number was saved. ${err.message}`, ...saved });
    console.error('Error in /api/firms/phone:', err);
    res.status(502).json({ error: changed ? 'The number was saved, but the code could not be sent. Check that it is a mobile number and try again.' : 'The number could not be saved. Please try again.', ...saved });
  }
});

// ─── Stripe ───────────────────────────────────────────────────────────────────
// Reached from the last sign-up step and, for a firm that stopped before paying, from its portal (both tokens
// open the firm's account).
app.post('/api/billing/checkout', async (req, res) => {
  const { firmId, token, from } = req.body;
  if (!firmId) return res.status(400).json({ error: 'firmId required' });
  if (!(await ownsRegistration(token, firmId))) return res.status(401).json({ error: REGISTRATION_EXPIRED });
  const firm = await getFirm(firmId);
  if (!firm) return res.status(404).json({ error: 'Firm not found' });
  if (!firm.phone_verified) return res.status(403).json({ error: 'Please verify your phone number first.' });
  // A second subscription would bill the firm twice.
  if (firm.subscription_active) return res.status(409).json({ error: 'Your subscription is already active.' });
  if (['past_due', 'unpaid'].includes(firm.subscription_status)) {
    return res.status(409).json({ error: 'Your subscription has a payment due. Update your card under Manage Billing.' });
  }
  try {
    const stripeCustomerId = await ensureStripeCustomer(firm);
    // Stripe may already hold a subscription that its event has not yet switched on (a firm back from paying).
    const live = firm.stripe_customer_id ? await liveSubscription(stripeCustomerId) : null;
    if (live) {
      return res.status(409).json({ error: live.status === 'active' || live.status === 'trialing'
        ? 'Your subscription is already in place. It will show as active here within a minute.'
        : 'Your firm already has a subscription with a payment due. Update your card under Manage Billing.' });
    }
    const session = await createSubscriptionCheckout({ stripeCustomerId, firmId: firm.id, from: from === 'portal' ? 'portal' : 'register' });
    res.json({ url: session.url });
  } catch (err) { serverError(req, res, err); }
});

app.get('/api/billing/portal', async (req, res) => {
  const tokenData = await validateToken(req.query.token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid token' });
  if (!linkOpensAccount(tokenData)) return res.status(403).json({ error: ACCOUNT_ONLY });
  // A firm that has never paid has nothing to manage yet: its portal offers to start the subscription.
  if (!tokenData.stripe_customer_id) return res.redirect('/portal.html?billing=none');
  try {
    const portal = await createPortalSession({ stripeCustomerId: tokenData.stripe_customer_id });
    res.redirect(portal.url);
  } catch (err) { serverError(req, res, err); }
});

app.post('/api/webhooks/stripe', async (req, res) => {
  let event;
  try { event = constructWebhookEvent(req.body, req.headers['stripe-signature']); }
  catch (err) { return refuseWebhook(res, err); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.subscription) {
      try {
        // The firm is named on the session (metadata or client_reference_id) and on the subscription; sessions
        // created before this change named it only on the subscription, which this event does not carry.
        const details = await getSubscriptionDetails(session.subscription);
        const firmId  = session.metadata?.firmId || session.client_reference_id || details.firmId;
        // Another app's checkout, on a Stripe account the suite shares: its firm number means another firm here.
        const app = session.metadata?.app || details.app;
        if (app && app !== APP_ID) {
          console.log(`Checkout session ${session.id} belongs to ${app}; ignored`);
        } else if (firmId) {
          const stripeCustomerId = typeof session.customer === 'string' ? session.customer : (session.customer?.id || null);
          const firm = await getFirm(firmId);
          if (firm?.stripe_customer_id && stripeCustomerId && firm.stripe_customer_id !== stripeCustomerId) {
            console.warn(`Checkout session ${session.id} paid as customer ${stripeCustomerId}, but firm ${firmId} is customer ${firm.stripe_customer_id}; the firm's customer is kept`);
          }
          await updateFirmSubscription(firmId, { stripeSubscriptionId: session.subscription, stripePaymentMethodId: details.paymentMethodId, stripeCustomerId, status: details.status });
          console.log(`Firm ${firmId} subscription activated`);
          // Once per subscription: Stripe can send the same event more than once.
          if (firm?.email && firm.stripe_subscription_id !== session.subscription && (details.status === 'active' || details.status === 'trialing')) {
            try {
              const token = await createMagicLink(firmId, { expiresInHours: 720 });
              await sendFirmWelcomeEmail(firm, `${APP_URL}/portal.html?token=${token}`);
            } catch (err) {
              console.error(`Welcome email to firm ${firmId} failed:`, err.message);
            }
          }
        } else {
          console.error(`Checkout session ${session.id} names no firm; subscription ${session.subscription} not activated`);
        }
      } catch (err) {
        // Answered 500 so Stripe retries the event; switching a subscription on is safe to repeat. It used to
        // answer 200, and a firm that paid stayed switched off if this step failed once.
        console.error('Subscription activation error:', err.message);
        return res.status(500).json({ error: 'Subscription activation failed; Stripe will retry' });
      }
    }
  }

  // A subscription that stops being paid stops the firm's leads until it is paid again; a failed payment used
  // to leave them coming. The subscription's live status is read from Stripe, so events that arrive out of
  // order cannot switch a firm on or off wrongly. The Stripe webhook must send these four events.
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const object = event.data.object;
    const subscriptionId = event.type.startsWith('customer.subscription.')
      ? object.id
      : (object.subscription || object.parent?.subscription_details?.subscription || null);
    if (subscriptionId) {
      try {
        const { status, paymentMethodId } = await getSubscriptionDetails(subscriptionId);
        const firms = await setSubscriptionStatus(subscriptionId, status, paymentMethodId);
        console.log(`Subscription ${subscriptionId} is ${status}: ${firms} firm(s) updated`);
      } catch (err) {
        console.error('Subscription status update error:', err.message);
        return res.status(500).json({ error: 'Subscription update failed; Stripe will retry' });
      }
    }
  }

  // A firm that changes its card under Manage Billing changes its customer's default card; later lead charges
  // use it. The card is read from Stripe, so events that arrive out of order cannot restore an old one.
  if (event.type === 'customer.updated') {
    const customerId = event.data.object?.id;
    if (customerId) {
      try {
        const card = await getCustomerCard(customerId);
        if (card) console.log(`Customer ${customerId}'s card saved for ${await setCustomerCard(customerId, card)} firm(s)`);
      } catch (err) {
        console.error('Card update error:', err.message);
        return res.status(500).json({ error: 'Card update failed; Stripe will retry' });
      }
    }
  }
  res.json({ received: true });
});

// ─── Auctions ─────────────────────────────────────────────────────────────────
app.get('/api/auctions/:id', async (req, res) => {
  const tokenData = await validateToken(req.query.token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired link' });
  if (!linkOpensAuction(tokenData, req.params.id)) return res.status(403).json({ error: WRONG_AUCTION });
  await sweepExpiredAuctions();   // a finished auction shows as closed, and its winner is charged
  const status = await getAuctionStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'Auction not found' });
  const [myBid] = await sql`SELECT amount FROM bids WHERE auction_id = ${req.params.id} AND firm_id = ${tokenData.firm_id} ORDER BY amount DESC LIMIT 1`;
  status.isLeading  = status.currentBid === (myBid ? parseFloat(myBid.amount) : -1);
  status.myBid      = myBid ? parseFloat(myBid.amount) : null;
  status.firmName   = tokenData.name;
  status.tierConfig = TIER_CONFIG[status.tier];
  res.json(status);
});

app.post('/api/auctions/:id/bid', async (req, res) => {
  const { token, amount } = req.body;
  const tokenData = await validateToken(token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired link' });
  if (!linkOpensAuction(tokenData, req.params.id)) return res.status(403).json({ error: WRONG_AUCTION });
  if (!tokenData.subscription_active) return res.status(403).json({ error: 'Active subscription required' });
  if (!tokenData.approved_at) return res.status(403).json({ error: 'Your firm is awaiting approval.' });
  if (tokenData.suspended_until && new Date(tokenData.suspended_until) > new Date()) return res.status(403).json({ error: `Account suspended until ${new Date(tokenData.suspended_until).toLocaleDateString()}` });
  res.json(await placeBid(req.params.id, tokenData.firm_id, parseFloat(amount)));
});

// ─── Leads ────────────────────────────────────────────────────────────────────
// The lead's data with each citation-audit row that names a decision given the screen label that decision has now in the
// library (`matched_case_screen`), worked out when the page is read and never written back. A row names a decision by the
// retrieved case it is anchored to, or else by the address the gate's CourtListener lookup found for it. A failed lookup
// labels every such row not screened.
async function withScreenLabels(leadData) {
  const audit = leadData?.evaluation?.citation_audit;
  if (!Array.isArray(audit)) return leadData;
  const addressOf = row => row?.matched_case_url || row?.courtlistener_url;
  const idOf = row => {
    const found = /\/opinion\/(\d+)\//.exec(String(addressOf(row) || ''));
    return found ? Number(found[1]) : null;
  };
  const named = audit.filter(row => row && typeof row === 'object' && addressOf(row));
  if (!named.length) return leadData;
  let states = new Map();
  try {
    states = await screenStates(sql, named.map(idOf).filter(id => id !== null));
  } catch (err) {
    console.error('Could not read the screen states for a lead:', withoutKeys(err?.message || String(err)).slice(0, 300));
  }
  const labelled = audit.map(row => (named.includes(row)
    ? { ...row, matched_case_screen: shownScreen(states.get(idOf(row))) }
    : row));
  return { ...leadData, evaluation: { ...leadData.evaluation, citation_audit: labelled } };
}

app.get('/api/leads/:id', async (req, res) => {
  const tokenData = await validateToken(req.query.token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired link' });
  if (!linkOpensLead(tokenData, req.params.id)) return res.status(403).json({ error: WRONG_LEAD });
  const [lead] = await sql`SELECT * FROM leads WHERE id = ${req.params.id} AND firm_id = ${tokenData.firm_id}`;
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  let fullData = null;
  if (lead.auction_id) {
    const [auction] = await sql`SELECT lead_data, lead_preview, quality_score, tier, score_dimensions FROM auctions WHERE id = ${lead.auction_id}`;
    fullData = { ...auction?.lead_data, preview: auction?.lead_preview, score: auction?.quality_score, tier: auction?.tier, dimensions: auction?.score_dimensions };
  } else if (lead.lead_data) {
    // A cold lead has no auction: the lead row keeps what the firm bought.
    fullData = { ...lead.lead_data, tier: lead.tier };
  }
  // Leads stored before deadlines travelled with them get theirs from the conversation.
  if (fullData && !fullData.deadlines && Array.isArray(fullData.history)) fullData.deadlines = deadlineNotices(fullData.history);
  fullData = await withScreenLabels(fullData);
  // The notice the visitor and the AI are given for this case type, shown above the audit when the audit has rows. A failed read gives none.
  // (A test sets app.locals.loadNotes to read other notes.)
  const audit = fullData?.evaluation?.citation_audit;
  const caseNotice = Array.isArray(audit) ? noticeForReply(lead.case_type, audit, app.locals.loadNotes) : null;
  const daysLeft     = Math.max(0, Math.ceil((new Date(lead.accept_deadline) - new Date()) / (1000 * 60 * 60 * 24)));
  // The same 30-day count declineLead uses, so the policy shown is the one applied.
  const recent       = await recentDeclineCounts(tokenData.firm_id);
  const coldCount    = recent.cold + 1;
  const auctionCount = recent.auction + 1;
  const isAuction    = !!lead.auction_id;
  const declinePolicy = isAuction
    ? (auctionCount === 1 ? { refundPct: 50, message: '50% refund' } : auctionCount === 2 ? { refundPct: 25, message: '25% refund' } : { refundPct: 0, message: 'No refund + 30-day suspension' })
    : (coldCount <= 3 ? { refundPct: 100, message: 'Full refund' } : { refundPct: 50, message: '50% refund' });
  res.json({ id: lead.id, status: lead.status, caseType: lead.case_type, tier: lead.tier, auctionId: lead.auction_id, pricePaid: parseFloat(lead.price_paid), acceptDeadline: lead.accept_deadline, daysLeft, leadData: fullData, caseNotice, declinePolicy });
});

app.post('/api/leads/:id/accept', async (req, res) => {
  const { token, hitlVerification } = req.body || {};
  // A lead is accepted only after the supervising attorney confirms the four checks on lead.html.
  // The page enforces this too; this is the same rule where calling the endpoint directly cannot skip it.
  if (!isHitlVerificationComplete(hitlVerification)) {
    return res.status(400).json({ error: 'Confirm all four supervising-attorney checks before accepting this lead.' });
  }
  const tokenData = await validateToken(token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid token' });
  if (!linkOpensLead(tokenData, req.params.id)) return res.status(403).json({ error: WRONG_LEAD });
  // The supervising attorney's checks are stored on the lead. They used to be only logged, and the host keeps
  // logs for about an hour.
  const firm = await getFirm(tokenData.firm_id);
  const attestation = {
    ...Object.fromEntries(HITL_ATTESTATION_KEYS.map(key => [key, true])),
    attestedAt: new Date().toISOString(),
    // The firm's supervising attorney on file at sign-up; the page does not record who clicked.
    attorneyOnFile: firm?.attorney_name || null,
    attorneyRegistrationOnFile: firm?.attorney_registration || null,
  };
  const result = await acceptLead(req.params.id, tokenData.firm_id, attestation);
  if (result.ok) {
    console.log(`[HITL] Lead ${req.params.id} accepted by firm ${tokenData.firm_id} with the supervising attorney's four checks`);
  }
  res.json(result);
});

// A decline says why (DECLINE_REASONS): the operator learns which leads are bad, and a lead declined for a reason
// of the firm's own is offered to another firm.
app.post('/api/leads/:id/decline', async (req, res) => {
  const { token, reason } = req.body || {};
  if (!Object.hasOwn(DECLINE_REASONS, reason)) return res.status(400).json({ error: 'Choose why you are declining this lead.' });
  const tokenData = await validateToken(token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid token' });
  if (!linkOpensLead(tokenData, req.params.id)) return res.status(403).json({ error: WRONG_LEAD });
  res.json(await declineLead(req.params.id, tokenData.firm_id, reason));
});

// ─── Firm Portal ──────────────────────────────────────────────────────────────
app.post('/api/firms/portal-link', limitEmails, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const firm = await findFirmByEmail(email);
    if (!firm) return res.status(404).json({ error: 'No firm found with that email address' });
    const token = await createMagicLink(firm.id, { expiresInHours: 720 });
    const url   = `${APP_URL}/portal.html?token=${token}`;
    await sendPortalLinkEmail(firm, url);
    res.json({ ok: true });
  } catch (err) { serverError(req, res, err); }
});

const PORTAL_PAGE_SIZE = 20;
app.get('/api/portal', async (req, res) => {
  const tokenData = await validateToken(req.query.token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired link' });
  if (!linkOpensAccount(tokenData)) return res.status(403).json({ error: ACCOUNT_ONLY });
  // The portal is the firm's record of what it bought: every lead (20 at a time; ?offset= for the next), whether it
  // came from an auction, what was refunded and when it was answered, and this month's totals. It used to show the
  // last 20 leads with their prices only.
  const offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 100_000);
  if (offset === 0) await sweepExpiredAuctions();   // a lead just won shows at once
  const rows = await sql`
    SELECT id, case_type, tier, price_paid, refund_amount, status, decline_reason, (auction_id IS NOT NULL) AS from_auction,
           created_at, accepted_at, declined_at
    FROM leads WHERE firm_id = ${tokenData.firm_id}
    ORDER BY created_at DESC, id DESC
    LIMIT ${PORTAL_PAGE_SIZE + 1} OFFSET ${offset}
  `;
  const page = { leads: rows.slice(0, PORTAL_PAGE_SIZE), hasMore: rows.length > PORTAL_PAGE_SIZE, nextOffset: offset + Math.min(rows.length, PORTAL_PAGE_SIZE) };
  if (offset > 0) return res.json(page);   // "Show more": the next leads only

  const firm = await getFirm(tokenData.firm_id);
  // Calendar month in New York. A refund counts in the month the lead was declined, when it is issued.
  const [month] = await sql`
    WITH start AS (SELECT date_trunc('month', NOW() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' AS at)
    SELECT count(*) FILTER (WHERE l.created_at >= start.at)::int AS leads,
           COALESCE(sum(l.price_paid) FILTER (WHERE l.created_at >= start.at), 0) AS charged,
           COALESCE(sum(l.refund_amount) FILTER (WHERE l.declined_at >= start.at), 0) AS refunded
    FROM start LEFT JOIN leads l ON l.firm_id = ${tokenData.firm_id}
    GROUP BY start.at`;
  const auctions = await openAuctionsFor(tokenData.firm_id);
  res.json({
    firm, ...page, auctions,
    month: { leads: month?.leads || 0, charged: parseFloat(month?.charged || 0), refunded: parseFloat(month?.refunded || 0) },
  });
});

// A fresh link to an open auction listed in the portal.
app.post('/api/portal/auction-link', async (req, res) => {
  const { token, auctionId } = req.body;
  const tokenData = await validateToken(token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired link' });
  if (!linkOpensAccount(tokenData)) return res.status(403).json({ error: ACCOUNT_ONLY });
  if (!/^\d{1,12}$/.test(String(auctionId ?? ''))) return res.status(400).json({ error: 'auctionId required' });
  try {
    const url = await portalAuctionLink(tokenData.firm_id, auctionId);
    if (!url) return res.status(404).json({ error: 'That auction has closed, or your firm was not invited to it.' });
    res.json({ url: url.slice(APP_URL.length) });
  } catch (err) {
    serverError(req, res, err);
  }
});

app.put('/api/portal/profile', async (req, res) => {
  const { token, specializations, serviceArea, contactName } = req.body;
  const tokenData = await validateToken(token);
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired link' });
  if (!linkOpensAccount(tokenData)) return res.status(403).json({ error: ACCOUNT_ONLY });
  await updateFirmProfile(tokenData.firm_id, { specializations, serviceArea, contactName });
  res.json({ ok: true });
});

// ─── Admin ────────────────────────────────────────────────────────────────────
// Without ADMIN_SECRET the admin routes are closed to everyone; they used to be open to everyone.
function requireAdmin(req, res) {
  if (!process.env.ADMIN_SECRET) { res.status(503).json({ error: 'Admin access is not configured' }); return false; }
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Unauthorized' }); return false;
  }
  return true;
}

app.get('/api/admin/firms', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  // With each firm's leads, what it has paid after refunds, and its declines in the last 30 days.
  const firms = await sql`
    SELECT f.*,
      (SELECT count(*) FROM leads l WHERE l.firm_id = f.id)::int AS leads_bought,
      (SELECT COALESCE(sum(COALESCE(l.price_paid, 0) - COALESCE(l.refund_amount, 0)), 0) FROM leads l WHERE l.firm_id = f.id) AS net_spend,
      (SELECT count(*) FROM leads l WHERE l.firm_id = f.id AND l.status = 'declined' AND l.declined_at > NOW() - INTERVAL '30 days')::int AS declines_30d
    FROM firms f ORDER BY f.created_at DESC`;
  const [counts]   = await sql`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE subscription_active) AS active, COUNT(*) FILTER (WHERE NOT active) AS inactive FROM firms`;
  const [leadCounts] = await sql`SELECT COUNT(*) AS total FROM leads`;
  res.json({ firms, counts, leadCounts });
});

app.patch('/api/admin/firms/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { active, approved, specializations, serviceArea, contactName } = req.body;
  if (typeof approved === 'boolean') {
    const firmBefore = await getFirm(req.params.id);
    await approveFirm(req.params.id, approved);
    // Told once, when first approved.
    if (approved && !firmBefore?.approved_at && firmBefore?.email) {
      try {
        const token = await createMagicLink(req.params.id, { expiresInHours: 720 });
        await sendFirmApprovalEmail(firmBefore, `${APP_URL}/portal.html?token=${token}`);
      } catch (err) {
        console.error(`Approval email to firm ${req.params.id} failed:`, err.message);
      }
    }
  }
  if (typeof active === 'boolean') await sql`UPDATE firms SET active = ${active} WHERE id = ${req.params.id}`;
  if (specializations !== undefined || serviceArea !== undefined || contactName !== undefined) await updateFirmProfile(req.params.id, { specializations, serviceArea, contactName });
  res.json({ ok: true });
});

app.post('/api/admin/firms/:id/send-link', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const firm = await getFirm(req.params.id);
  if (!firm) return res.status(404).json({ error: 'Firm not found' });
  const token = await createMagicLink(firm.id, { expiresInHours: 720 });
  const url   = `${APP_URL}/portal.html?token=${token}`;
  await sendPortalLinkEmail(firm, url);
  // The link goes only to the firm's own email; it is not handed back to the caller.
  res.json({ ok: true });
});

// ─── Admin: requests, auctions and leads ─────────────────────────────────────
// The operator's view of every consented contact request and what became of it, which used to need database
// access: the alerts said the contact details were "saved with the conversation", with no screen to read them.
app.get('/api/admin/requests', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const requests = await sql`
      SELECT c.session_id, c.case_type, c.mode, c.name, c.phone, c.email, c.best_time, c.contact_consent_at, c.lead_sent_at,
             c.lead_score->>'tier' AS tier, c.lead_score->>'score' AS score,
             (SELECT COALESCE(json_agg(json_build_object('id', l.id, 'firm_id', l.firm_id, 'firm_name', f.name, 'status', l.status,
                       'price_paid', l.price_paid, 'decline_reason', l.decline_reason) ORDER BY l.created_at), '[]'::json)
                FROM leads l LEFT JOIN firms f ON f.id = l.firm_id WHERE l.session_id = c.session_id) AS leads,
             (SELECT COALESCE(json_agg(json_build_object('id', a.id, 'status', a.status, 'tier', a.tier, 'current_bid', a.current_bid) ORDER BY a.created_at), '[]'::json)
                FROM auctions a WHERE a.session_id = c.session_id) AS auctions,
             (SELECT COALESCE(json_agg(json_build_object('id', f.id, 'name', f.name) ORDER BY u.created_at), '[]'::json)
                FROM unconfirmed_charges u JOIN firms f ON f.id = u.firm_id WHERE u.session_id = c.session_id) AS unconfirmed_firms
      FROM conversations c
      WHERE c.contact_consent_at IS NOT NULL
      ORDER BY c.contact_consent_at DESC LIMIT 100`;
    res.json({ requests, declineReasons: DECLINE_REASONS });
  } catch (err) { serverError(req, res, err); }
});

// One request with its conversation, to read before calling the client or delivering it by hand.
app.get('/api/admin/requests/:sessionId', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [request] = await sql`
      SELECT session_id, mode, case_type, name, phone, email, best_time, contact_consent_at, contact_consent_text, lead_sent_at, lead_score, history
      FROM conversations WHERE session_id = ${req.params.sessionId} AND contact_consent_at IS NOT NULL LIMIT 1`;
    if (!request) return res.status(404).json({ error: 'No consented request with that session' });
    res.json({ request });
  } catch (err) { serverError(req, res, err); }
});

// Delivers a consented request by hand, at a price (0 for a free sample lead), to a subscribed firm the app draws,
// within the three firms the client agreed to. A firm can be named only to finish a delivery whose charge Stripe
// could not confirm.
app.post('/api/admin/requests/:sessionId/deliver', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const named = req.body?.firmId !== undefined && req.body?.firmId !== null;
  const firmId = named ? Number(req.body.firmId) : null;
  const price = Math.round(Number(req.body?.price ?? 0) * 100) / 100;
  if (named && (!Number.isInteger(firmId) || firmId <= 0)) return res.status(400).json({ error: 'Choose a firm.' });
  if (named && price !== 0) return res.status(400).json({ error: 'A delivery to a firm whose charge could not be confirmed is finished at $0: check that charge in Stripe first.' });
  if (!Number.isFinite(price) || price < 0 || price > 5000) return res.status(400).json({ error: 'Enter a price from $0 to $5,000.' });
  try {
    const [conv] = await sql`
      SELECT session_id, mode, case_type, history, lead_score, gate_audit, name, phone, email, best_time, contact_consent_at, contact_consent_text
      FROM conversations WHERE session_id = ${req.params.sessionId} AND contact_consent_at IS NOT NULL LIMIT 1`;
    if (!conv) return res.status(404).json({ error: 'No consented request with that session' });
    const leadData = leadDataFrom(conv, { name: conv.name, phone: conv.phone, email: conv.email || null, bestTime: conv.best_time || null, consentedAt: conv.contact_consent_at, consentText: conv.contact_consent_text || CONTACT_CONSENT_TEXT });
    const score = conv.lead_score || {};
    const result = await deliverLeadByHand({
      sessionId: conv.session_id, firmId, price, type: conv.case_type, leadData,
      scoreData: { score: score.score, preview: score.preview, tier: score.tier || 'cold' },
    });
    res.status(result.ok ? 200 : result.status || 500).json(result.ok ? { ok: true, leadId: result.leadId, emailed: result.emailed, firmId: result.firmId, firmName: result.firmName, ...(result.error ? { warning: result.error } : {}) } : { error: result.error });
  } catch (err) { serverError(req, res, err); }
});

app.get('/api/admin/auctions', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const auctions = await sql`
      SELECT a.id, a.session_id, a.case_type, a.tier, a.quality_score, a.reserve_price, a.current_bid, a.status, a.closes_at, a.created_at,
             a.winner_firm_id, a.winning_bid, w.name AS winner_name,
             (SELECT count(*) FROM bids b WHERE b.auction_id = a.id)::int AS bid_count
      FROM auctions a LEFT JOIN firms w ON w.id = a.winner_firm_id
      ORDER BY a.created_at DESC LIMIT 100`;
    res.json({ auctions });
  } catch (err) { serverError(req, res, err); }
});

// An auction stuck 'closing' (a charge Stripe could not confirm, or a win that was not recorded) is finished by
// hand: the operator checks Stripe, delivers the lead from the request if it was paid for, and cancels the auction.
app.post('/api/admin/auctions/:id/cancel', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [cancelled] = await sql`UPDATE auctions SET status = 'cancelled' WHERE id = ${req.params.id} AND status IN ('open', 'closing') RETURNING id`;
    if (!cancelled) return res.status(409).json({ error: 'Only an open or closing auction can be cancelled.' });
    res.json({ ok: true });
  } catch (err) { serverError(req, res, err); }
});

app.get('/api/admin/leads', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const leads = await sql`
      SELECT l.id, l.session_id, l.auction_id, l.firm_id, f.name AS firm_name, l.case_type, l.tier, l.price_paid, l.status,
             l.refund_amount, l.stripe_refund_id, l.decline_reason, l.created_at, l.accepted_at, l.declined_at
      FROM leads l LEFT JOIN firms f ON f.id = l.firm_id
      ORDER BY l.created_at DESC LIMIT 200`;
    res.json({ leads, declineReasons: DECLINE_REASONS });
  } catch (err) { serverError(req, res, err); }
});

// ─── Admin: the decisions held ───────────────────────────────────────────────
// The "Decisions held" section of the admin page: the library decisions the nightly screen held for the owner, each cleared
// or banned by hand. Only a held decision can be decided; a second click, or a decision the screen changed meanwhile, is a 409.
app.get('/api/admin/decisions', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (req.query.state !== undefined && req.query.state !== 'held') return res.status(400).json({ error: 'Only held decisions can be listed' });
  try {
    res.json({ decisions: await heldDecisions(sql) });
  } catch (err) { serverError(req, res, err); }
});

// The answer names the state the decision was left in. A ban leaves it banned. A clear leaves it clear, or unscreened when
// its hold answered no question (decideHeld sends it back to be screened), so the state is read from the row.
for (const [verb, decision] of [['clear', 'clear'], ['ban', 'banned']]) {
  app.post(`/api/admin/decisions/:clusterId/${verb}`, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!/^\d{1,18}$/.test(req.params.clusterId)) return res.status(400).json({ error: 'Not a decision id' });
    try {
      const changed = await decideHeld(sql, req.params.clusterId, decision, new Date().toISOString());
      if (!changed) return res.status(409).json({ error: 'That decision is not held' });
      const [row] = decision === 'banned' ? [{ screen_state: 'banned' }] : await sql`SELECT screen_state FROM case_library WHERE cluster_id = ${req.params.clusterId}`;
      res.json({ ok: true, cluster_id: Number(req.params.clusterId), screen_state: row?.screen_state ?? null });
    } catch (err) { serverError(req, res, err); }
  });
}

// ─── Admin: the models ───────────────────────────────────────────────────────
// The Models section of the admin page (admin.html): the chains each job runs with, the state of each provider, the
// measurements on record, and the models the form may offer. The chains are a setting in the database, checked before
// they are saved (model-settings.js); the measurements are sent by `npm run models:upload`.
app.get('/api/admin/models', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [current, onRecord, providers] = await Promise.all([chains(), measurements(), providerStates()]);
    // The chat models the registry holds, and whether each one's provider has a key (by name only: never its value).
    const registry = Object.entries(MODELS).filter(([, entry]) => entry.embedding !== true).map(([model, entry]) => ({
      model, provider: entry.provider, hasKey: Boolean(process.env[KEY_NAMES[entry.provider]]), retiresOn: entry.retiresOn ?? null,
    }));
    const { answer, small, source, override } = current;
    res.json({ chains: { answer, small }, source, override, providers, measurements: onRecord, registry });
  } catch (err) { serverError(req, res, err); }
});

// Saves the chains when nothing is wrong with them. There is one admin secret and it is the owner's, so the owner is who
// saved. `override` is the owner's "use anyway, not measured": only true counts.
app.post('/api/admin/models/chains', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { answer, small, override } = req.body || {};
    const result = await saveChains({ answer, small }, { by: 'owner', override: override === true });
    res.status(result.ok ? 200 : 422).json({ ok: result.ok, errors: result.errors, warnings: result.warnings });
  } catch (err) { serverError(req, res, err); }
});

// The measurements `npm run models:upload` sends, for this app only. A body with any malformed row stores nothing.
app.post('/api/admin/models/measurements', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { app: appName, rows } = req.body || {};
    if (appName !== APP_ID) return res.status(400).json({ error: `These measurements are for ${typeof appName === 'string' ? appName.slice(0, 60) : 'no app'}; this site holds those of ${APP_ID}.` });
    const problems = checkMeasurementRows(rows);
    if (problems.length) return res.status(400).json({ error: problems.slice(0, 10).join(' ') });
    const result = await recordMeasurements(rows);
    if (!result.ok) return res.status(500).json({ error: result.errors.join(' '), saved: result.saved });
    res.json({ saved: result.saved });
  } catch (err) { serverError(req, res, err); }
});

// ─── Case Types ───────────────────────────────────────────────────────────────
app.get('/api/case-types', (_req, res) => {
  res.json({
    caseTypes: [
      'Surgical Error', 'Failure to Diagnose / Misdiagnosis', 'Medication Error',
      'Birth Injury', 'Anesthesia Error', 'Hospital Negligence',
      'Nursing Home Neglect', 'Dental Malpractice',
    ],
  });
});

app.post('/api/reset-session', async (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) { try { await sql`DELETE FROM conversations WHERE session_id = ${sessionId}`; } catch {} }
  res.json({ ok: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Saves the conversation after each reply, with the latest lead score and the gate's audit of the
// latest reply. The name, phone number and best time to call are saved only by /api/contact, from the
// form the visitor submits with consent; they are no longer picked out of the chat text.
async function upsertConversation(sessionId, mode, caseType, history, leadScore = null, gateAudit = null, { clearLeadScore = false } = {}) {
  await sql`
    INSERT INTO conversations (session_id, mode, case_type, history, lead_score, gate_audit, updated_at)
    VALUES (${sessionId}, ${mode}, ${caseType}, ${JSON.stringify(history)}, ${leadScore ? JSON.stringify(leadScore) : null}, ${gateAudit ? JSON.stringify(gateAudit) : null}, NOW())
    ON CONFLICT (session_id) DO UPDATE SET
      mode = EXCLUDED.mode, case_type = COALESCE(EXCLUDED.case_type, conversations.case_type),
      history = EXCLUDED.history,
      lead_score = CASE WHEN ${clearLeadScore} THEN NULL ELSE COALESCE(EXCLUDED.lead_score, conversations.lead_score) END,
      gate_audit = COALESCE(EXCLUDED.gate_audit, conversations.gate_audit), updated_at = NOW()
  `;
}

// What a firm receives with a lead: the conversation, its score, the client's contact details and consent, and the
// gate's audit of the last reply. Used for a request sent from the contact form and for one the operator delivers.
function leadDataFrom(conv, contact) {
  const score = conv.lead_score || {};
  return {
    caseType: conv.case_type, mode: conv.mode, history: conv.history,
    preview: score.preview, score: score.score, dimensions: score.dimensions, scoredAt: score.scoredAt || null,
    deadlines: deadlineNotices(conv.history),
    // The exact consent travels with the lead, which is kept for 3 years: the conversation that also records
    // it is deleted after 90 days.
    contact,
    // The gate's full audit of the last reply — every attempt, the citation audit and the
    // checklist for the supervising attorney — for the reviewing firm (lead.html).
    evaluation: conv.gate_audit || null,
  };
}

function getTransporter() {
  if (isDemo()) return demoMailer;   // the demo copy keeps its mail in the demo outbox
  if (!process.env.SMTP_USER) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'mail.jwd.nyc', port: parseInt(process.env.SMTP_PORT || '465'), secure: true, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // A stalled mail server is given up on after 10 seconds; nodemailer would wait minutes, past the time
    // limit of the request that is sending.
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000,
  });
}

async function sendPortalLinkEmail(firm, url) {
  const t    = getTransporter();
  const html = `<div style="font-family:sans-serif;max-width:580px;margin:auto"><h2 style="color:#9e3a5a">Your MalpracticeAI Firm Portal</h2><p>Hi ${firm.name},</p><p>Use the link below to access your firm portal.</p><p style="margin:1.5rem 0"><a href="${url}" style="background:#9e3a5a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Access Your Portal →</a></p><p style="color:#999;font-size:12px">Valid for 30 days. Do not share.</p></div>`;
  if (!t) { console.log(`[EMAIL MOCK] Portal link → ${firm.email}: ${url}`); return; }
  await t.sendMail({ from: process.env.SMTP_USER, to: firm.email, subject: 'Your MalpracticeAI Firm Portal Access Link', html });
}

async function sendFirmApprovalEmail(firm, url) {
  const t    = getTransporter();
  const html = `<div style="font-family:sans-serif;max-width:580px;margin:auto"><h2 style="color:#9e3a5a">Your NYCMalpractice.ai firm account is approved</h2><p>Hi ${escapeHtml(firm.name)},</p><p>We have checked your supervising attorney's New York registration, and your firm account is approved.</p><p>Once your subscription is active, matching leads and auction invitations reach you by email and in your firm portal. You can set your practice areas there.</p><p style="margin:1.5rem 0"><a href="${url}" style="background:#9e3a5a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Open your firm portal →</a></p><p style="color:#999;font-size:12px">This link is valid for 30 days. Do not share it.</p></div>`;
  if (!t) { console.log(`[EMAIL MOCK] Firm approval email → ${firm.email}: ${url}`); return; }
  await t.sendMail({ from: process.env.SMTP_USER, to: firm.email, subject: 'Your NYCMalpractice.ai firm account is approved', html });
}

async function sendFirmWelcomeEmail(firm, url) {
  const t    = getTransporter();
  const html = `<div style="font-family:sans-serif;max-width:580px;margin:auto"><h2 style="color:#9e3a5a">Welcome to NYCMalpractice.ai</h2><p>Hi ${escapeHtml(firm.name)},</p><p>Thank you for subscribing. Your $199 a month subscription is active.</p><p>Before any lead is sent, we check your supervising attorney's registration with the New York court system. If that is not done yet, you will get an approval email when it is, and leads start then.</p><p style="margin:1.5rem 0"><a href="${url}" style="background:#9e3a5a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Open your firm portal →</a></p><p style="color:#999;font-size:12px">This link is valid for 30 days. You can change your card or subscription under Billing in your portal.</p></div>`;
  if (!t) { console.log(`[EMAIL MOCK] Firm welcome email → ${firm.email}: ${url}`); return; }
  await t.sendMail({ from: process.env.SMTP_USER, to: firm.email, subject: 'Welcome to NYCMalpractice.ai: subscription confirmed', html });
}

// ─── Cron Endpoints ───────────────────────────────────────────────────────────
// Without CRON_SECRET the job routes are closed to everyone; they used to run for any caller.
function verifyCron(req, res) {
  if (!process.env.CRON_SECRET) { res.status(503).json({ error: 'Scheduled jobs are not configured' }); return false; }
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' }); return false;
  }
  return true;
}

// The models a chain or a default uses: what the monthly look at the providers' lists checks (model-watch.js).
async function modelsInUse() {
  const { answer, small } = await chains();
  return [...answer, ...small, ...DEFAULTS.answer, ...DEFAULTS.small, ...DEFAULTS.embedding];
}

function watchProviderModels() {
  return modelWatch({ today: new Date(), sqlClient: sql, adapters: adaptersFor(process.env), notify: notifyOperator, inUse: modelsInUse, registry: MODELS, site: SITE_NAME });
}

// The nightly read of every statute the notes rest on (statute-watch.js): reads and tells the owner, changes nothing a visitor
// reads. The key is read when the step runs, so that a deploy without it fails this step, which is reported that night.
function watchStatutes() {
  const key = process.env.NYSENATE_API_KEY;
  if (!key) throw new Error('NYSENATE_API_KEY is not set in this deployment');
  return statuteWatch({
    today: new Date(), sqlClient: sql, law: readLawFile(CURRENT_LAW_FILE), snapshotOf: snapshotReader(STATUTE_TEXTS_DIR),
    readSource: sourceReader(key), notify: sendOperatorNotice, site: SITE_NAME,
  });
}

// Combined nightly job — this is the path vercel.json actually schedules. Until it existed the
// scheduled call got a 404 and nothing ran: expired auctions stayed open and overdue leads pending.
// Runs close-auctions → overdue-leads → reset-declines → the 90-day conversation purge, in sequence.
// The nightly job. Each step runs whatever happened to the ones before it (a failure used to stop every later
// step, the privacy deletions included); the run is recorded for /health/deep, failed steps are emailed to the
// operator, and a summary of the day goes out with it. A failed step makes the answer a 500.
app.get('/api/cron', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    const { declineOverdueLeads, reportStuckAuctions } = await import('./auction.js');
    const { resetDeclineCounts } = await import('./firms.js');
    // The privacy policy's retention periods: conversations after 90 days, lead records after 3 years (retention.js).
    const { purgeExpiredConversations, purgeExpiredLeadRecords } = await import('./retention.js');
    const { backupRecords } = await import('./backup.js');

    // The deletions the privacy policy promises go first: the steps that charge cards and send email take longest.
    const { results, failed } = await runSteps([
      ['delete old conversations', purgeExpiredConversations],
      ['delete old lead records', purgeExpiredLeadRecords],
      ['back up business records offsite', backupRecords],
      ['close expired auctions', closeExpiredAuctions],
      ['report stuck auctions', reportStuckAuctions],
      ['decline overdue leads', declineOverdueLeads],
      ['recount declines', resetDeclineCounts],
      // Once a month, and on the nights a model's retirement is 60, 30 or 7 days away: reads and tells, switches nothing.
      ['watch the model lists of the providers', watchProviderModels],
    ]);
    await recordJobRun('nightly', failed).catch(err => console.error('Recording the nightly run failed:', err.message));
    await reportFailedSteps('nightly', failed);
    await sendDailyDigest({ failed }).catch(err => console.error('The daily summary failed:', err.message));
    res.status(failed.length ? 500 : 200).json({
      ok: failed.length === 0,
      closed: results['close expired auctions'] ?? null,
      declined: results['decline overdue leads'] ?? null,
      purged: { ...(results['delete old conversations'] || {}), ...(results['delete old lead records'] || {}) },
      backup: results['back up business records offsite']?.status || null,
      failed: failed.map(f => f.step),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// The statute watch has a job of its own at 06:00 UTC, the hour before the nightly one: the Senate's API is slow enough that
// reading the watched sections must not share the nightly job's minute, and Vercel stops a function at 60 seconds.
app.get('/api/cron/statute-watch', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    const { results, failed } = await runSteps([['check the watched statutes', watchStatutes]]);
    await recordJobRun('statute-watch', failed).catch(err => console.error('Recording the statute watch run failed:', err.message));
    await reportFailedSteps('statute watch', failed);
    const watched = results['check the watched statutes'];
    res.status(failed.length ? 500 : 200).json({
      ok: failed.length === 0,
      checked: watched?.checked ?? null,
      differing: watched?.differing ?? null,
      unread: watched?.unread ?? null,
      failed: failed.map(f => f.step),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// The case library's refresh (library-refresh.js) has a job of its own at 03:00 UTC, answered by the second function
// (api/jobs.js, five minutes): the topic searches are spaced to keep inside CourtListener's allowance, so a run takes
// minutes where a reply must not. The token and the limits are read when the step runs. This app's pages cite no decision,
// so the refresh has no pins to look up.
const numberSetting = (name, fallback) => (process.env[name] && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback);

function refreshCaseLibrary() {
  const token = process.env.COURTLISTENER_TOKEN;
  if (!token) throw new Error('COURTLISTENER_TOKEN is not set in this deployment');
  return refreshLibrary({
    sqlClient: sql, topics: CASE_TOPICS, pins: [], search: searchTopic, lookupPins: lookupCitations,
    allowance: () => readAllowance({ token }), maxSearches: numberSetting('LIBRARY_SEARCHES_PER_NIGHT', 10), reserve: numberSetting('COURTLISTENER_RESERVE', 30),
  });
}

app.get('/api/cron/library', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    const { results, failed } = await runSteps([['refresh the case library', refreshCaseLibrary]]);
    await recordJobRun('library', failed).catch(err => console.error('Recording the case library run failed:', err.message));
    await reportFailedSteps('case library', failed);
    const refreshed = results['refresh the case library'];
    res.status(failed.length ? 500 : 200).json({
      ok: failed.length === 0,
      searched: refreshed?.searched ?? null,
      added: refreshed?.added ?? null,
      dropped: refreshed?.dropped ?? null,
      pinsResolved: refreshed?.pinsResolved ?? null,
      stoppedBecause: refreshed ? refreshed.stoppedBecause : null,
      failed: failed.map(f => f.step),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// The screen of the case library (case-screen.js) runs twice a night, at 04:00 and 05:00 UTC, on the second function. The
// scheduler calls it with ?run=1 and ?run=2; the number is not read, so both runs do the same work and a call without it
// does too. A held decision is emailed to the owner through the same notice the statute watch uses.
function screenCaseLibrary() {
  const token = process.env.COURTLISTENER_TOKEN;
  if (!token) throw new Error('COURTLISTENER_TOKEN is not set in this deployment');
  return screenDecisions({
    sqlClient: sql, search: searchForScreen, allowance: () => readAllowance({ token }), notify: sendOperatorNotice, site: SITE_NAME,
    maxRequests: numberSetting('SCREEN_REQUESTS_PER_RUN', 20), reserve: numberSetting('COURTLISTENER_RESERVE', 30),
  });
}

app.get('/api/cron/screen', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    const { results, failed } = await runSteps([['screen the case library', screenCaseLibrary]]);
    await recordJobRun('screen', failed).catch(err => console.error('Recording the screen run failed:', err.message));
    await reportFailedSteps('screen', failed);
    const screened = results['screen the case library'];
    res.status(failed.length ? 500 : 200).json({
      ok: failed.length === 0,
      screened: screened?.screened ?? null,
      cleared: screened?.cleared ?? null,
      held: screened?.held ?? null,
      requests: screened?.requests ?? null,
      notifyFailed: screened?.notifyFailed ?? null,
      stoppedBecause: screened ? screened.stoppedBecause : null,
      failed: failed.map(f => f.step),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

app.get('/api/cron/close-auctions', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    res.json({ closed: await closeExpiredAuctions() });
  } catch (err) { serverError(req, res, err); }
});

app.get('/api/cron/overdue-leads', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    const { declineOverdueLeads } = await import('./auction.js');
    res.json({ declined: await declineOverdueLeads() });
  } catch (err) { serverError(req, res, err); }
});

// `gatekeeper` reports whether the compliance rubrics and current-law notes load in this deployment.
// They are read from rubrics/*.json at runtime, so this is the quickest way to see they were bundled.
function gatekeeperHealth() {
  try {
    loadRubric('personal');
    loadRubric('estate');
    loadCurrentLawNotes();
    return 'ok';
  } catch (err) {
    console.error('[Health] Gatekeeper rubrics failed to load:', err.message);
    return 'rubrics_unavailable';
  }
}

// Whether this is the demo copy: the pages ask (site-mode.js), on any host but the live site, and say so.
app.get('/api/site-mode', (_req, res) => res.json({ demo: isDemo() }));

// The emails and texts the demo copy would have sent. Only the demo has one.
app.get('/demo/outbox', async (req, res) => {
  if (!isDemo()) return res.status(404).send('Not found');
  try {
    res.type('html').send(outboxPage(await outboxMessages(100)));
  } catch (err) {
    serverError(req, res, err);
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'malpractice-ai', gatekeeper: gatekeeperHealth() }));
// For an uptime monitor: the database, its columns and the nightly job (operations.js). 503 when any is wrong.
app.get('/health/deep', async (_req, res) => {
  const health = await deepHealth();
  res.status(health.ok ? 200 : 503).json(health);
});
app.get('/health/models', async (_req, res) => {
  await refreshModelHealthSnapshot();
  // And each provider that has an adapter: 'up', or marked down since when and why (provider-state.js).
  res.json({ ...modelHealthSnapshot, providers: await providerStates() });
});

// One chain's part of the health snapshot: the first model that answers a ping, and the rest of the chain. Each
// ping goes through the spending caps. Whatever stops the chain (no model answered, the cap was reached, an error
// that is no provider's) leaves it with no model active.
async function chainHealth(name, chain) {
  const shape = active => ({ active, fallbacks_available: chain.filter(model => model !== active) });
  try {
    return shape((await runJob({ job: 'health', chain })).model);
  } catch (err) {
    // A provider's own words can quote a key, so they are cleaned and cut.
    console.error(`[Health] ${name} model chain has no callable model: ${withoutKeys(err.message).slice(0, 300)}`);
    return shape(null);
  }
}

async function refreshModelHealthSnapshot({ force = false } = {}) {
  const now = Date.now();
  const isFresh = modelHealthLastCheckedAt && (now - modelHealthLastCheckedAt) < MODEL_HEALTH_TTL_MS;
  if (!force && isFresh) return modelHealthSnapshot;
  if (modelHealthRefreshPromise) return modelHealthRefreshPromise;

  // The reply and small-job chains in use (model-settings.js), under the names this page has always given them; the
  // embedding chain is no setting.
  modelHealthRefreshPromise = chains()
    .then(({ answer, small }) => Promise.all([
      chainHealth('answer', answer),
      chainHealth('aux', small),
      chainHealth('embedding', DEFAULTS.embedding),
    ]))
    .then(([answer, aux, embedding]) => {
      modelHealthSnapshot = { answer, aux, embedding };
      modelHealthLastCheckedAt = Date.now();
      console.log('[Health] Model callable check:', JSON.stringify(modelHealthSnapshot));
      return modelHealthSnapshot;
    })
    .catch((err) => {
      console.error('[Health] Model probe refresh failed:', err.message);
      return modelHealthSnapshot;
    })
    .finally(() => {
      modelHealthRefreshPromise = null;
    });

  return modelHealthRefreshPromise;
}

// ─── Start ────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test' && (process.env.NODE_ENV !== 'production' || !process.env.VERCEL)) {
  const PORT = process.env.PORT || 3003;
  if (process.env.DISABLE_BACKGROUND_JOBS === '1') {
    app.listen(PORT, () => console.log(`MalpracticeAI running on http://localhost:${PORT}`));
  } else {
    import('./cron.js').then(({ startCronJobs }) => startCronJobs());
    refreshModelHealthSnapshot({ force: true })
      .finally(() => {
        app.listen(PORT, () => console.log(`MalpracticeAI running on http://localhost:${PORT}`));
      });
  }
}

// ─── Errors no route caught ───────────────────────────────────────────────────
// Logged in full; the caller gets a plain message, never the internal error text or a stack trace. A request
// body that is not valid JSON is a 400.
app.use((err, req, res, _next) => {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(`Unhandled error in ${req.method} ${req.path}:`, err);
  if (res.headersSent) return;
  res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : 'The request could not be read.' });
});

export default app;
