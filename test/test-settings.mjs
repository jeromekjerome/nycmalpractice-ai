// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The settings every unit-test process runs with. Each test file imports this first, before any module of the app, so
// that no test process, the whole suite or one file run alone, loads the local .env with its live keys, its mail login
// and its live database address (test/test-settings.test.mjs checks that every test file does).
//
// Each is forced, whatever the shell has set:
// - dotenv, which db.js and server.js load, is pointed at an empty file;
// - the database address is one no database answers at, so that no client is ever made for another;
// - OpenAI's key is a made-up one, and Anthropic's and Google's are empty, so that Claude and Gemini have no adapter, as
//   in production before the owner adds their keys. The New York Senate's key is empty too, so that no test reaches the
//   Senate's service with the owner's. They are set, not left unset, because dotenv leaves a variable
//   that is already set (even empty) alone.
// A test that needs another value sets it itself, after this.
//
// This file has no imports, so that nothing is loaded before it: the one builtin it needs comes from the process.
const { fileURLToPath } = process.getBuiltinModule('node:url');

process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = fileURLToPath(new URL('./no-settings.env', import.meta.url));
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ANTHROPIC_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.NYSENATE_API_KEY = '';
