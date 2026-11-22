// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The monthly look at each provider's models, one step of the nightly job. A provider adds and retires models without
// telling the app, and a model the chains use can vanish from its list. On the first night of each month the watch
// reads every keyed provider's list (adapter.listModels), keeps it in the table provider_model_lists (setup-db.js) and
// emails the owner what changed: the models listed now that were not listed in the month before, in the families the
// app uses (gpt-, claude-, gemini-), and any model of the chains in use or the defaults that its provider no longer
// lists. On any night it also emails when such a model retires exactly 60, 30 or 7 days away (`retiresOn` in
// model-registry.js). The two go in one email when they fall on the same night.
//
// - The watch reads and tells; it never switches a model, a chain or a setting.
// - A provider is asked once a month: its list is stored under the month's first day, and a night that finds it
//   stored asks nothing. The claim is an INSERT ... ON CONFLICT DO NOTHING RETURNING that only one instance can win.
// - A list that cannot be read is named in the email and not stored, so the next night asks again. A thrown error's text
//   goes through withoutKeys before it reaches an email.
// - Without the table the monthly part cannot run: the email says so and names the command that makes it. The
//   retirement reminders need no table and still go out.
// - A model whose provider has no adapter (no key) is named once, on the month's first night, as not checked.
// - The days and the month are New York's, as the measurement dates are.
//
// This file is shared with the sister app (shared-code.json), so it knows nothing of either app's chains: the caller
// hands over the models in use, the registry and the site's name.
import { withoutKeys } from './without-keys.js';
import { MODELS } from './model-registry.js';

const TIME_ZONE = 'America/New_York';
const REMIND_AT = [60, 30, 7];
const FAMILIES = ['gpt-', 'claude-', 'gemini-'];
const DAY_MS = 86_400_000;

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// New York's calendar day of a moment, as YYYY-MM-DD.
function newYorkDay(moment) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(moment));
}

function daysBetween(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
}

const names = list => escapeHtml(list.join(', '));

/**
 * @param {object} options
 * @param {Date|number|string} options.today   the moment of the run
 * @param {Function} options.sqlClient         a tagged-template SQL client (neon)
 * @param {object} options.adapters            the keyed providers' adapters, by provider name; each has listModels()
 * @param {Function} options.notify            notify(subject, html): emails the owner
 * @param {Function} [options.inUse]           async () => the model names of the chains in use and the defaults
 * @param {object} [options.registry]          model name -> { provider, retiresOn? }; model-registry.js's by default
 * @param {string} [options.site]              the site's name, for the subject of each email
 * @returns {Promise<{ ran: boolean, email?: string }>} ran: some provider's list was stored by this run; email: the subject sent
 */
export async function modelWatch({ today, sqlClient, adapters, notify, inUse = async () => [], registry = MODELS, site = '' }) {
  const day = newYorkDay(today);
  const month = `${day.slice(0, 7)}-01`;
  const prefix = site ? `${site}: ` : '';
  const used = [...new Set(await inUse())];
  const providerOfUsed = model => (Object.hasOwn(registry, model) ? registry[model].provider : null);
  const sections = [];

  // The monthly look.
  let ran = false;
  let monthly = false;
  let tableError = null;
  try {
    const done = new Set((await sqlClient`SELECT provider FROM provider_model_lists WHERE month = ${month}`).map(row => row.provider));
    const firstOfMonth = done.size === 0;
    const reads = [];
    for (const [provider, adapter] of Object.entries(adapters).filter(([provider]) => !done.has(provider))) {
      try {
        const listed = await adapter.listModels();
        if (!Array.isArray(listed)) throw new Error('the list came back in a shape the app does not know');
        reads.push({ provider, listed: [...new Set(listed.map(String))] });
      } catch (error) {
        monthly = true;
        sections.push(`<p>${escapeHtml(provider)}'s list of models could not be read (${escapeHtml(withoutKeys(error?.message ?? error))}). It is tried again tomorrow night.</p>`);
      }
    }
    const fresh = [];
    const vanished = [];
    const firstLooks = [];
    for (const { provider, listed } of reads) {
      const [before] = await sqlClient`SELECT models FROM provider_model_lists WHERE provider = ${provider} AND month < ${month} ORDER BY month DESC LIMIT 1`;
      const claimed = await sqlClient`INSERT INTO provider_model_lists (provider, month, models) VALUES (${provider}, ${month}, ${JSON.stringify(listed)}::jsonb) ON CONFLICT (provider, month) DO NOTHING RETURNING provider`;
      if (!claimed.length) continue; // another instance stored it first, and tells the owner
      ran = true;
      monthly = true;
      if (before) {
        const known = new Set(before.models);
        const added = listed.filter(model => !known.has(model) && FAMILIES.some(family => model.startsWith(family)));
        if (added.length) fresh.push({ provider, added });
      } else {
        firstLooks.push(provider);
      }
      const gone = used.filter(model => providerOfUsed(model) === provider && !listed.includes(model));
      if (gone.length) vanished.push({ provider, gone });
    }
    if (ran) {
      if (fresh.length) {
        for (const { provider, added } of fresh) sections.unshift(`<p>${escapeHtml(provider)} lists ${added.length === 1 ? 'a model' : 'models'} it did not list last month: ${names(added)}.</p>`);
      } else if (!firstLooks.length || reads.length > firstLooks.length) {
        sections.unshift('<p>No provider lists a model in the families the app uses (gpt-, claude-, gemini-) that it did not list last month.</p>');
      }
      for (const provider of firstLooks) sections.push(`<p>This is the first look at ${escapeHtml(provider)}'s list, so there is nothing to compare it with yet; it is kept for next month.</p>`);
      for (const { provider, gone } of vanished) {
        sections.push(`<p>${names(gone)} ${gone.length === 1 ? 'is' : 'are'} no longer listed by ${escapeHtml(provider)}, though a model chain or a default still uses ${gone.length === 1 ? 'it' : 'them'}. A job that asks for ${gone.length === 1 ? 'it' : 'one'} will fail over to the next model of its chain.</p>`);
      }
    }
    if (ran && firstOfMonth) {
      const unchecked = used.filter(model => providerOfUsed(model) && !Object.hasOwn(adapters, providerOfUsed(model)));
      if (unchecked.length) sections.push(`<p>These models are not checked: no key is set for their provider: ${names(unchecked)}.</p>`);
    }
  } catch (error) {
    tableError = error;
    sections.length = 0;
    sections.push('<p>This month\'s look at the providers\' model lists was not made: the table provider_model_lists could not be read or written ' +
      `(${escapeHtml(withoutKeys(error?.message ?? error))}). Run <code>npm run setup-db</code> against the production database. It is tried again tomorrow night.</p>`);
  }
  if (monthly && !tableError) sections.push('<p>Nothing has been switched: the app runs the models it ran before.</p>');

  // The reminders of a retirement.
  const reminders = [];
  for (const model of used) {
    const retiresOn = Object.hasOwn(registry, model) ? registry[model].retiresOn : null;
    if (!retiresOn) continue;
    const away = daysBetween(day, retiresOn);
    if (REMIND_AT.includes(away)) reminders.push({ model, away, retiresOn });
  }
  for (const { model, away, retiresOn } of reminders) {
    sections.push(`<p>${escapeHtml(model)} is shut down by its provider on ${escapeHtml(retiresOn)}, ${away} days from today, and a model chain or a default still uses it. Choose its replacement from the admin page, with a measurement on record, before then.</p>`);
  }

  if (!sections.length) return { ran };
  const subject = monthly || tableError ? `${prefix}${tableError ? 'the providers\' model lists could not be checked' : 'what changed in the providers\' model lists this month'}`
    : reminders.length === 1 ? `${prefix}${reminders[0].model} retires in ${reminders[0].away} days` : `${prefix}${reminders.length} models retire soon`;
  await notify(subject, sections.join(''));
  return { ran, email: subject };
}
