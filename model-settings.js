// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The chains each job runs with, as a setting the owner saves (the design, section 3, "Settings, not code"): one row
// of the table app_settings (setup-db.js), under the key model_chains, read at most once a minute by each server
// instance. The built-in chains of models.js stand behind it: they are used until a row is saved, and whenever the row
// cannot be read or names a model the registry no longer has, so that a bad row can never stop a reply. The embedding
// chain is not a setting.
//
// - chains() gives { answer, small, source, override }: the saved chains (source 'settings', with the override they
//   were saved under, or null) or the built-in ones ('defaults').
//   Every caller of a model asks for it at the start of its job, so that a save reaches every job within a minute.
// - checkChains() says whether chains may be saved; every fact it needs is handed to it. saveChains() gathers those
//   facts (the measurements on record in model_measurements, which providers have a key, what each provider lists
//   today) and saves only when nothing is wrong. A model with no measurement, or one that misses the part of the bar
//   its place needs, is let in only under the owner's override, which the row records and the daily summary repeats
//   until each such model has a measurement on record.
// - A measurement run gives the app chains of its own (useChainsForMeasurement), and no setting is read.
//
// This file is the same in each app. The app gives it the database client, the app's name in model_measurements and
// the telling of the owner (configureModelSettings); with no database it gives the built-in chains.
import { DEFAULTS } from './models.js';
import { entryFor as registryEntryFor } from './model-registry.js';
import { modelsOffered as listedByProviders } from './providers.js';
import { MEASURE_DATABASE_URL } from './measure-address.js';
import { withoutKeys } from './without-keys.js';

// The row's key in app_settings.
const CHAINS_KEY = 'model_chains';
// How long a read of the row is used before the row is read again.
const MEMORY_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
// A model its provider shuts down within this many days cannot be saved in a chain.
const RETIREMENT_NOTICE_DAYS = 60;

// The setting that holds each provider's key. A save asks only whether it is set, by its name; the value is never
// kept, printed or logged.
export const KEY_NAMES = Object.freeze({ openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GEMINI_API_KEY' });

// The two chains, by their names in the row and in model_measurements ('answer' and 'small'), and in the owner's words.
const CHAINS = [
  { role: 'answer', name: 'reply chain', as: 'a reply model' },
  { role: 'small', name: 'small-job chain', as: 'a small-job model' },
];

const isChain = value => Array.isArray(value) && value.length > 0 && value.every(model => typeof model === 'string' && model.trim() !== '');
const priced = entry => Array.isArray(entry?.price) && entry.price.length === 2 && entry.price.every(Number.isFinite);
const days = count => `${count} day${count === 1 ? '' : 's'}`;

function builtIn() {
  return { answer: [...DEFAULTS.answer], small: [...DEFAULTS.small], source: 'defaults', override: null };
}

// The measurement on record that counts for a model in one place: the latest for that model and role.
function measurementOf(measurements, model, role) {
  let found = null;
  for (const row of Array.isArray(measurements) ? measurements : []) {
    if (row?.model !== model || row?.role !== role) continue;
    if (!found || String(row.measuredOn ?? '') >= String(found.measuredOn ?? '')) found = row;
  }
  return found;
}

// What a model's measurement says against its place, in the owner's words: null when it meets what the place needs.
// A main model must meet the whole bar; a fallback, its quality part. Under the override it is a warning, not an error.
function measurementProblem({ name, as }, model, place, measured, override) {
  const head = override ? `Under the override, the ${name}` : `The ${name}`;
  if (!measured) {
    return `${head} names ${model}, which has no measurement on record as ${as}${override ? '; the daily summary will say so until it has one' : ''}.`;
  }
  if (place === 0 && measured.barOk !== true) {
    return `${head} has ${model} as its main model, ${override ? 'though' : 'but'} its measurement on record as ${as} does not meet the whole bar${override ? '' : ', which a main model must'}.`;
  }
  if (place > 0 && measured.qualityOk !== true) {
    return `${head} has ${model} as a fallback, ${override ? 'though' : 'but'} its measurement on record as ${as} does not meet the quality part of the bar${override ? '' : ', which a fallback must'}.`;
  }
  return null;
}

// The whole check: the errors, the warnings, and the models the override let in, as [{ model, role }].
function review(proposed, { measurements = [], keysPresent = [], liveModels = {}, override = false, now = Date.now(), entryFor = registryEntryFor } = {}) {
  const keyed = new Set(keysPresent);
  const errors = [];
  const warnings = [];
  const waived = new Map();
  for (const place of CHAINS) {
    const { role, name } = place;
    const chain = proposed?.[role];
    if (!isChain(chain)) {
      errors.push(`The ${name} must be a list of one or more model names.`);
      continue;
    }
    for (const model of new Set(chain.filter((model, at) => chain.indexOf(model) !== at))) errors.push(`The ${name} names ${model} twice.`);

    chain.forEach((model, at) => {
      const entry = entryFor(model);
      if (!entry) {
        errors.push(`The ${name} names ${model}, which is not in the registry of models (model-registry.js).`);
        return;
      }
      // A chat chain runs chat jobs; an embedding model cannot, and no override lifts that.
      if (entry.embedding === true) {
        errors.push(`The ${name} names ${model}, which is an embedding model, not one that writes answers.`);
        return;
      }
      const { provider } = entry;
      if (!priced(entry)) errors.push(`The ${name} names ${model}, which has no price on record, so the spending caps could not count what it costs.`);
      // The day the provider shuts the model down is taken from its first moment, in UTC.
      const shutdown = Date.parse(`${entry.retiresOn}T00:00:00Z`);
      if (Number.isFinite(shutdown) && shutdown - now <= RETIREMENT_NOTICE_DAYS * DAY_MS) {
        errors.push(shutdown <= now
          ? `The ${name} names ${model}, which ${provider} shut down on ${entry.retiresOn}.`
          : `The ${name} names ${model}, which ${provider} shuts down on ${entry.retiresOn}, in ${days(Math.ceil((shutdown - now) / DAY_MS))}: a model in a chain must have more than ${RETIREMENT_NOTICE_DAYS} days left.`);
      }
      // A provider's list can only be read with its key.
      if (!keyed.has(provider)) {
        errors.push(`The ${name} names ${model}, but ${provider} has no key${KEY_NAMES[provider] ? ` (${KEY_NAMES[provider]} is not set)` : ''}.`);
      } else if (!Array.isArray(liveModels?.[provider])) {
        errors.push(`The ${name} names ${model}, but the list of models ${provider} offers could not be read to check it.`);
      } else if (!liveModels[provider].includes(model)) {
        errors.push(`The ${name} names ${model}, which is not in the list of models ${provider} offers today.`);
      }
      const problem = measurementProblem(place, model, at, measurementOf(measurements, model, role), override);
      if (problem && override) {
        warnings.push(problem);
        waived.set(`${role} ${model}`, { model, role });
      } else if (problem) {
        errors.push(problem);
      }
    });

    // An outage takes all of a provider's models at once, so in a chain of more than one provider a model's fallback
    // is another provider's. A chain of one provider has no other to fall back to: it may be saved, with a warning.
    const providers = chain.map(model => entryFor(model)?.provider ?? null);
    const distinct = new Set(providers.filter(Boolean));
    if (distinct.size > 1) {
      providers.forEach((provider, at) => {
        if (provider && provider === providers[at + 1]) {
          errors.push(`The ${name} puts ${chain[at]} and ${chain[at + 1]}, both ${provider}'s, side by side: in a chain of more than one provider, the model after each must be another provider's, since an outage takes all of a provider's models at once.`);
        }
      });
    }
    if (distinct.size === 1) warnings.push(`The ${name} has one provider; it has no fallback if that provider is down.`);
    if (distinct.size === 2) warnings.push(`The ${name} has two providers, not three: if both are down at once, it has no fallback.`);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], waived: [...waived.values()] };
}

/**
 * Whether chains may be saved. Every fact it needs is handed to it, so that it reaches nothing.
 * @param {{ answer: string[], small: string[] }} proposed
 * @param {object} facts
 * @param {Array} facts.measurements   the measurements on record: [{ model, role, measuredOn, qualityOk, barOk }]
 * @param {Iterable<string>} facts.keysPresent  the providers whose key is set
 * @param {object} facts.liveModels    { [provider]: the names it lists today, or null when its list could not be read }
 * @param {boolean} [facts.override]   the owner's "use anyway, not measured"
 * @param {number} [facts.now]         the time, for the retirement dates
 * @param {Function} [facts.entryFor]  the registry (model-registry.js); tests give a registry of stand-ins
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function checkChains(proposed, facts = {}) {
  const { errors, warnings } = review(proposed, facts);
  return { ok: errors.length === 0, errors, warnings };
}

const copyOf = override => (override ? { ...override, models: override.models.map(item => ({ ...item })) } : null);

// The rules each bar holds a model to (measure/report.mjs), which a measurement's rows name when they miss one.
const RULES = {
  answer: ['finalPass', 'unanchored', 'seminar', 'speed', 'graded', 'baseline'],
  small: ['json', 'type', 'tier', 'verdict', 'leadScore', 'knownBad', 'speed', 'baseline'],
};
const MAX_STATS_CHARS = 100_000;
const RUN_LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/;

/**
 * What is wrong with the rows of an upload of measurements (measure/upload.mjs), one line each naming its row; none
 * when they may all be stored. A row: { model, role, measuredOn, runLabel, qualityOk, barOk, failed, stats }.
 */
export function checkMeasurementRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return ['The upload holds no rows.'];
  const problems = [];
  const seen = new Map();
  rows.forEach((row, at) => {
    const number = at + 1;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      problems.push(`Row ${number} (?, ?): a row must be an object.`);
      return;
    }
    const about = `Row ${number} (${typeof row.model === 'string' ? row.model : ''}, ${typeof row.runLabel === 'string' ? row.runLabel : ''})`;
    const wrong = what => problems.push(`${about}: ${what}`);
    if (typeof row.model !== 'string' || !row.model.trim() || row.model.length > 100) wrong('model must be a name.');
    if (!CHAINS.some(({ role }) => role === row.role)) wrong('role must be "answer" or "small".');
    if (typeof row.runLabel !== 'string' || !RUN_LABEL.test(row.runLabel)) wrong('runLabel must be a run label: letters, digits, dots and hyphens.');
    const day = typeof row.measuredOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.measuredOn) ? new Date(`${row.measuredOn}T00:00:00Z`) : null;
    if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== row.measuredOn) wrong('measuredOn must be a date as YYYY-MM-DD.');
    if (typeof row.qualityOk !== 'boolean') wrong('qualityOk must be true or false.');
    if (typeof row.barOk !== 'boolean') wrong('barOk must be true or false.');
    if (!Array.isArray(row.failed)) {
      wrong('failed must be a list of rules.');
    } else {
      const known = RULES[row.role];
      for (const rule of row.failed) {
        if (known && !known.includes(rule)) wrong(`failed names ${typeof rule === 'string' ? rule : 'something that is no rule'}, which is not a rule of the ${row.role === 'answer' ? 'reply' : 'small-job'} bar.`);
      }
      if (row.barOk === true && row.failed.length) wrong('barOk is true, but failed names rules.');
    }
    if (!row.stats || typeof row.stats !== 'object' || Array.isArray(row.stats)) wrong('stats must be an object.');
    else if (JSON.stringify(row.stats).length > MAX_STATS_CHARS) wrong('stats is too large.');
    const key = `${row.model}|${row.role}|${row.runLabel}`;
    if (seen.has(key)) problems.push(`${about} repeats row ${seen.get(key)}.`);
    else seen.set(key, number);
  });
  return problems;
}

// The chains in a saved row: two lists of model names, and the override it records, or null when it is no such row.
function savedIn(value) {
  let row = value;
  if (typeof row === 'string') {
    try { row = JSON.parse(row); } catch { return null; }
  }
  if (!row || typeof row !== 'object' || !isChain(row.answer) || !isChain(row.small)) return null;
  return { answer: [...row.answer], small: [...row.small], override: overrideIn(row.override) };
}

// The rules a measurement missed, as the upload stored them in stats.barFailed (neon gives the JSON parsed).
function failedIn(value) {
  let list = value;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  return Array.isArray(list) ? list.filter(rule => typeof rule === 'string') : [];
}

function overrideIn(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.models)) return null;
  const models = value.models
    .filter(item => typeof item?.model === 'string' && CHAINS.some(({ role }) => role === item.role))
    .map(({ model, role }) => ({ model, role }));
  return { overriddenBy: String(value.overriddenBy ?? ''), overriddenOn: String(value.overriddenOn ?? ''), models };
}

// The providers of the registered models the chains name.
function providersIn(proposed) {
  const named = CHAINS.flatMap(({ role }) => (Array.isArray(proposed?.[role]) ? proposed[role] : []));
  return [...new Set(named.map(model => registryEntryFor(model)?.provider).filter(Boolean))];
}

/**
 * One server instance's settings.
 * @param {object} [options]
 * @param {Function} [options.sqlClient]  the database's tagged-template client; with none, the built-in chains
 * @param {string} [options.app]          the app's name in model_measurements (site.js's APP_ID)
 * @param {Function} [options.now]        the time, for the one-minute memory and the override's date
 * @param {Function} [options.tell]       tell({ kind: 'unknown_models', models }): the saved chains name models the
 *   registry does not have, so the built-in chains are used. Told at each read of such a row, at most once a minute;
 *   the app's telling decides how often the owner is emailed.
 * @param {object} [options.env]          where the keys and the database address are looked up, by name
 * @param {Function} [options.modelsOffered]  (providers) -> { [provider]: names | null }: what each provider lists
 * @returns {{ chains, measurements, recordMeasurements, saveChains, unmeasuredOverride, useChainsForMeasurement }}
 */
export function modelSettings({ sqlClient = null, app = null, now = Date.now, tell = null, env = process.env, modelsOffered = listedByProviders } = {}) {
  // The last read of the row, used for a minute: { at, settled: { answer, small, source, override } }.
  let memory = null;
  // The read in flight, which every caller meanwhile waits for. A save made while it is in flight wins over what it
  // finds: each save counts up `saves`, and a read that began before the last save does not replace it.
  let reading = null;
  let saves = 0;
  // The chains a measurement run gave the app.
  let measuring = null;
  // What this instance has said once.
  const said = new Set();

  function sayOnce(what, write, line) {
    if (said.has(what)) return;
    said.add(what);
    write(line);
  }

  // The owner is told without the job that read the chains waiting for the email: it goes on with the built-in chains.
  function tellOwner(note) {
    if (typeof tell !== 'function') return;
    new Promise(resolve => resolve(tell(note))).catch(error => {
      console.error(`[models] Telling the owner that the saved model chains name a model the registry does not have failed: ${withoutKeys(error?.message ?? error)}`);
    });
  }

  async function read() {
    let rows;
    try {
      rows = await sqlClient`SELECT value FROM app_settings WHERE key = ${CHAINS_KEY}`;
    } catch (error) {
      sayOnce('unreadable', console.error, `[models] The saved model chains could not be read, so the built-in chains are used: ${withoutKeys(error?.message ?? error)}`);
      return builtIn();
    }
    if (!rows?.length) {
      sayOnce('missing', console.log, '[models] No model chains are saved in the settings, so the built-in chains are used.');
      return builtIn();
    }
    const saved = savedIn(rows[0]?.value);
    if (!saved) {
      sayOnce('malformed', console.error, '[models] The saved model chains are not two lists of model names, so the built-in chains are used.');
      return builtIn();
    }
    const unknown = [...new Set([...saved.answer, ...saved.small])].filter(model => !registryEntryFor(model));
    if (unknown.length) {
      sayOnce('unknown', console.error, `[models] The saved model chains name ${unknown.join(', ')}, which the registry of models does not have, so the built-in chains are used.`);
      tellOwner({ kind: 'unknown_models', models: unknown });
      return builtIn();
    }
    return { ...saved, source: 'settings' };
  }

  // The chains as this instance knows them, reading the row at most once a minute.
  function settled() {
    if (memory && now() - memory.at < MEMORY_MS) return Promise.resolve(memory.settled);
    if (!reading) {
      const savesBefore = saves;
      reading = read().catch(() => builtIn()).then(found => {
        reading = null;
        if (saves !== savesBefore) return memory.settled;
        memory = { at: now(), settled: found };
        return found;
      });
    }
    return reading;
  }

  async function chains() {
    if (measuring) return { answer: [...measuring.answer], small: [...measuring.small], source: 'measurement', override: null };
    if (!sqlClient) {
      const { answer, small, source } = builtIn();
      return { answer, small, source, override: null };
    }
    const { answer, small, source, override } = await settled();
    return { answer: [...answer], small: [...small], source, override: copyOf(override) };
  }

  // The measurements on record for this app, oldest first. A table that cannot be read gives none: then no model can
  // be saved without the override.
  async function measurements() {
    if (!sqlClient) return [];
    try {
      const rows = await sqlClient`
        SELECT model, role, measured_on::text AS measured_on, run_label, quality_ok, bar_ok, stats->'barFailed' AS bar_failed
        FROM model_measurements
        WHERE app = ${app}
        ORDER BY measured_on, id`;
      return rows.map(row => ({ model: row.model, role: row.role, measuredOn: row.measured_on, runLabel: row.run_label, qualityOk: row.quality_ok === true, barOk: row.bar_ok === true, failed: failedIn(row.bar_failed) }));
    } catch (error) {
      sayOnce('measurements', console.error, `[models] The measurements on record could not be read, so none is counted: ${withoutKeys(error?.message ?? error)}`);
      return [];
    }
  }

  // Saves the chains when nothing is wrong with them (checkChains), and says what was found either way. `by` names
  // who is saving: the row records it, and when, with the models the override let in, only when the override did let
  // some in.
  async function saveChains(proposed, { by, override = false } = {}) {
    if (typeof by !== 'string' || !by.trim()) throw new TypeError('saveChains needs by: who is saving the chains.');
    if (!sqlClient) return { ok: false, errors: ['The chains cannot be saved: the app has no database for its settings.'], warnings: [] };
    const keysPresent = Object.keys(KEY_NAMES).filter(provider => Boolean(env[KEY_NAMES[provider]]));
    const listing = providersIn(proposed).filter(provider => keysPresent.includes(provider));
    const [onRecord, liveModels] = await Promise.all([measurements(), listing.length ? modelsOffered(listing) : {}]);
    const { errors, warnings, waived } = review(proposed, { measurements: onRecord, keysPresent, liveModels, override: override === true, now: now() });
    if (errors.length) return { ok: false, errors, warnings };

    const value = {
      answer: [...proposed.answer],
      small: [...proposed.small],
      ...(waived.length ? { override: { overriddenBy: by, overriddenOn: new Date(now()).toISOString(), models: waived } } : {}),
    };
    try {
      await sqlClient`
        INSERT INTO app_settings (key, value, updated_at) VALUES (${CHAINS_KEY}, ${JSON.stringify(value)}::jsonb, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    } catch (error) {
      return { ok: false, errors: [`The chains could not be saved: ${withoutKeys(error?.message ?? error)}`], warnings };
    }
    // This instance knows its own save at once; every other reads it within a minute.
    saves += 1;
    memory = { at: now(), settled: { answer: value.answer, small: value.small, source: 'settings', override: value.override ?? null } };
    return { ok: true, errors: [], warnings };
  }

  // Stores the measurements an upload sent (measure/upload.mjs), for this app. A row of a run already on record is
  // replaced when it differs, so that a corrected upload corrects the record, and is stored as nothing when it is
  // the same, so that sending the same upload twice stores nothing the second time. `saved` counts the rows stored.
  async function recordMeasurements(rows) {
    if (!sqlClient) return { ok: false, errors: ['The measurements cannot be saved: the app has no database for its settings.'], saved: 0 };
    const problems = checkMeasurementRows(rows);
    if (problems.length) return { ok: false, errors: problems, saved: 0 };
    let saved = 0;
    try {
      for (const row of rows) {
        // The rules the row missed travel with its figures; the row's own list is the one that counts.
        const stats = JSON.stringify({ ...row.stats, barFailed: row.failed });
        const stored = await sqlClient`
          INSERT INTO model_measurements (app, model, role, measured_on, run_label, quality_ok, bar_ok, stats)
          VALUES (${app}, ${row.model}, ${row.role}, ${row.measuredOn}::date, ${row.runLabel}, ${row.qualityOk}, ${row.barOk}, ${stats}::jsonb)
          ON CONFLICT (app, model, role, run_label) DO UPDATE SET
            measured_on = EXCLUDED.measured_on, quality_ok = EXCLUDED.quality_ok, bar_ok = EXCLUDED.bar_ok, stats = EXCLUDED.stats
          WHERE (model_measurements.measured_on, model_measurements.quality_ok, model_measurements.bar_ok, model_measurements.stats)
            IS DISTINCT FROM (EXCLUDED.measured_on, EXCLUDED.quality_ok, EXCLUDED.bar_ok, EXCLUDED.stats)
          RETURNING id`;
        saved += stored.length;
      }
    } catch (error) {
      // What was stored before the failure stays: sending the upload again stores the rest and none of those twice.
      return { ok: false, errors: [`The measurements could not be saved: ${withoutKeys(error?.message ?? error)}`], saved };
    }
    return { ok: true, errors: [], saved };
  }

  // The override of the saved chains while a model it let in has no measurement on record for the place it holds:
  // { overriddenBy, overriddenOn, models: [{ model, role }] } with those models, or null. The daily summary repeats it.
  async function unmeasuredOverride() {
    if (measuring || !sqlClient) return null;
    const { source, override } = await settled();
    if (source !== 'settings' || !override?.models.length) return null;
    const onRecord = await measurements();
    const models = override.models.filter(({ model, role }) => !measurementOf(onRecord, model, role));
    return models.length ? { overriddenBy: override.overriddenBy, overriddenOn: override.overriddenOn, models } : null;
  }

  // A measurement run's own chains, for the rest of the process. Only under the measurement's database address, which
  // no database answers at, so that the chains of a site can never be set this way.
  function useChainsForMeasurement({ answer, small } = {}) {
    if (env.DATABASE_URL !== MEASURE_DATABASE_URL) {
      throw new Error("Chains are handed to the app only in a measurement run, under the measurement's own database address.");
    }
    if (!isChain(answer) || !isChain(small)) throw new TypeError('A measurement run hands the app two lists of model names.');
    measuring = { answer: [...answer], small: [...small] };
  }

  return { chains, measurements, recordMeasurements, saveChains, unmeasuredOverride, useChainsForMeasurement };
}

// The settings every caller of a model reads. With nothing configured there is no database, and the built-in chains are
// used; the app gives it its database at start (server.js).
let current = modelSettings();

export function configureModelSettings(options = {}) {
  current = modelSettings(options);
}

export function chains() {
  return current.chains();
}

export function measurements() {
  return current.measurements();
}

export function recordMeasurements(rows) {
  return current.recordMeasurements(rows);
}

export function saveChains(proposed, options) {
  return current.saveChains(proposed, options);
}

export function unmeasuredOverride() {
  return current.unmeasuredOverride();
}

export function useChainsForMeasurement(given) {
  return current.useChainsForMeasurement(given);
}
