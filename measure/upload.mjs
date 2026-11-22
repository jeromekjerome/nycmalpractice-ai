// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Sends what the measurement runs say of each candidate model to the site, so that the admin page can check a chain
// against it (the measurements route of server.js, and model-settings.js).
//
//   npm run models:upload -- --app <app> --baseline <labels> [--small-baseline <labels>] [--replies <labels>]
//                            [--smalls <labels>] --site <address> [--yes]
//
// The run lists are the ones npm run models:report takes, and the judging is the report's own (scoreRuns), so the site
// holds what the report says. One row is sent for each candidate run: its model, the place it was measured for ('answer'
// for a reply run, 'small' for a small-job run), the run's date (New York's), whether it met the whole bar, whether it
// met the quality part (every rule but speed), the rules it missed, and its figures. Today's own runs are not candidates.
//
// It prints what it will send and where, and sends nothing without --yes. The admin secret is read from the environment
// (ADMIN_SECRET_FOR_UPLOAD), never from an argument; it goes in one header to the one address and is never printed.
//
// This file is the same in both apps.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRuns, parseReportArgs, scoreRuns } from './report.mjs';
import { MEASURE_DATABASE_URL } from '../measure-address.js';
import { withoutKeys } from '../without-keys.js';
import * as appAdapter from './app.mjs';

const USAGE = 'usage: npm run models:upload -- --app <app> --baseline <labels> [--small-baseline <labels>] [--replies <labels>] [--smalls <labels>] --site <address> [--yes]';
const ROUTE = '/api/admin/models/measurements';

// The address of the site: https, or this machine's own address for the tests. Only its origin is used, so that no path,
// login or query in what was typed can steer the request.
export function siteOrigin(address) {
  let url;
  try { url = new URL(address); } catch { throw new Error(`${address} is not an address`); }
  const own = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !own) throw new Error(`the site must be an https address (or http://127.0.0.1, or http://localhost, for a test), not ${url.protocol}//${url.hostname}`);
  if (url.username || url.password) throw new Error('the site address must carry no login');
  return url.origin;
}

// The report's flags, plus --site <address> and --yes, which the report's parser does not know.
export function parseUploadArgs(argv) {
  const rest = [];
  let site = null;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--yes') yes = true;
    else if (argv[i] === '--site') {
      if (argv[i + 1] === undefined) throw new Error('--site needs a value');
      site = argv[++i];
    } else rest.push(argv[i]);
  }
  const args = parseReportArgs(rest);
  for (const [flag, name] of [['--pairs', 'pairs'], ['--samples', 'samples'], ['--note', 'notes']]) {
    if (args[name].length) throw new Error(`${flag} is for the report; the upload takes none`);
  }
  if (!site) throw new Error('--site is required: the address of the site to send to');
  return { ...args, site: siteOrigin(site), yes };
}

// The date of a run's start, by New York's calendar, which is the owner's: the reports are dated so.
export function measuredOn(startedAt) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(startedAt));
  const of = type => parts.find(part => part.type === type)?.value;
  if (!of('year')) throw new Error(`${startedAt} is not a date`);
  return `${of('year')}-${of('month')}-${of('day')}`;
}

// The quality part of the bar is every rule but speed: a fallback must meet it (model-settings.js).
const qualityMet = bar => bar.failed.every(rule => rule === 'speed');

/**
 * One row for each candidate run, judged as the report judges it.
 * @param {object} runs   { baseline, smallBaseline, replies, smalls }: the runs, already read
 * @param {object} context  { price, visitors, adapter } as the report is given them
 */
export function rowsFor(runs, context) {
  const { candidateReply, candidateSmall } = scoreRuns(runs, context);
  const row = (role, model) => ({ run, stats, bar }) => ({
    model: model(run),
    role,
    measuredOn: measuredOn(run.startedAt),
    runLabel: run.label,
    qualityOk: qualityMet(bar),
    barOk: bar.ok,
    failed: [...bar.failed],
    // Through JSON, as the site receives it: what is sent is what is kept.
    stats: JSON.parse(JSON.stringify(stats)),
  });
  return [...candidateReply.map(row('answer', run => run.answer)), ...candidateSmall.map(row('small', run => run.aux))];
}

// What will be sent and where, a line each.
export function describeUpload({ site, app, rows }) {
  const lines = [`Upload of the model measurements of ${app}`, `  to: ${site}${ROUTE}`, `  rows: ${rows.length}`];
  for (const row of rows) {
    const bar = row.barOk ? 'meets the bar' : `misses ${row.failed.join(', ') || 'the bar'}`;
    lines.push(`  ${row.role}  ${row.model}  ${row.runLabel}  ${row.measuredOn}  ${bar}  quality: ${row.qualityOk ? 'met' : 'missed'}`);
  }
  return lines;
}

// Sends the rows. A redirect is an error: the header carrying the secret must go to the address that was printed.
export async function sendRows({ site, app, rows, secret, fetch }) {
  const response = await fetch(`${siteOrigin(site)}${ROUTE}`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-admin-secret': secret },
    body: JSON.stringify({ app, rows }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`the site answered ${response.status}${typeof body.error === 'string' ? `: ${withoutKeys(body.error.replaceAll(secret, '[secret withheld]')).slice(0, 300)}` : ''}`);
  if (!Number.isInteger(body.saved)) throw new Error('the site answered without saying how many rows it stored');
  return body.saved;
}

/**
 * The command. Everything it touches is handed in, so that a test can run it with stand-ins.
 * @returns {Promise<number>} the exit code
 */
export async function runUpload({ argv, env = process.env, fetch = globalThis.fetch, print = console.log, fail = console.error, readRun, adapter = appAdapter, price, visitors }) {
  let args;
  let runs;
  try {
    args = parseUploadArgs(argv);
    if (args.app !== adapter.APP) throw new Error(`this is ${adapter.APP}, not ${args.app}`);
    runs = Object.fromEntries(['baseline', 'smallBaseline', 'replies', 'smalls'].map(name => [name, args[name].map(readRun)]));
  } catch (error) {
    fail(`upload: ${error.message}`);
    fail(USAGE);
    return 1;
  }
  const problems = checkRuns({ app: adapter.APP, ...runs });
  if (problems.length) {
    fail('upload: these runs cannot be set beside one another:');
    for (const problem of problems) fail(`  ${problem}`);
    return 1;
  }
  const rows = rowsFor(runs, { price, adapter, ...(visitors ? { visitors } : {}) });
  if (!rows.length) {
    fail('upload: no candidate run was given (--replies or --smalls), so there is nothing to send.');
    return 1;
  }
  for (const line of describeUpload({ site: args.site, app: adapter.APP, rows })) print(line);
  if (!args.yes) {
    print('Nothing was sent. Run again with --yes to send these rows.');
    return 0;
  }
  const secret = env.ADMIN_SECRET_FOR_UPLOAD;
  if (!secret) {
    fail('upload: ADMIN_SECRET_FOR_UPLOAD is not set; it is the admin secret of the site, and is read from the environment only.');
    return 1;
  }
  try {
    const saved = await sendRows({ site: args.site, app: adapter.APP, rows, secret, fetch });
    print(`The site stored ${saved} of ${rows.length} rows (a row it already held, unchanged, is not stored again).`);
    return 0;
  } catch (error) {
    // The secret is never in a message: it was only ever a header. The text is cleaned anyway.
    fail(`upload: ${withoutKeys(error.message).replaceAll(secret, '[secret withheld]')}`);
    return 1;
  }
}

const here = dirname(fileURLToPath(import.meta.url));

function readRun(label) {
  try {
    return JSON.parse(readFileSync(join(here, 'results', `${label}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`there is no finished run named ${label} in measure/results`);
    throw error;
  }
}

async function main() {
  // The price table is the app's own, and its file opens the database client as it loads: it is given the
  // measurement's address, which no database answers at (the settings file this runs under holds the live one).
  process.env.DATABASE_URL = MEASURE_DATABASE_URL;
  const { estimateAiCost } = await import('../ai-budget.js');
  return runUpload({ argv: process.argv.slice(2), readRun, price: estimateAiCost });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(`upload: ${withoutKeys(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
