// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The database address a measurement run gives the app (measure/run.mjs). No database answers at it.
//
// It has a file of its own, which imports nothing, because two files need it that must not reach one another: the
// measurement's guard (measure/guard-fetch.mjs), which is imported before anything of the app and must never reach
// the database, and the app's model settings (model-settings.js), which read the database, and give a measurement run
// the chains it names only under this address. No file of the app imports from measure/.
export const MEASURE_DATABASE_URL = 'postgres://measure:measure@measure.invalid/none';
