// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The settings every unit-test process runs with (test/test-settings.mjs): that each test file imports them before
// anything else, and that they hold whatever the shell has set. Nothing here reaches a network or a database.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from './runner.mjs';

const FOLDER = new URL('./', import.meta.url);
const SETTINGS_IMPORT = "import './test-settings.mjs';";

// A file's first import as written: the first line that begins with "import". Imports are hoisted, so this is the
// first module the file loads.
function firstImport(source) {
  return source.split(/\r?\n/).find(line => /^import\b/.test(line))?.trim() ?? null;
}

test('every unit-test file imports the test settings before anything else', () => {
  // Every file a test process starts from: the test files, the suite's index among them, and a child a test runs.
  const files = readdirSync(FOLDER).filter(name => /\.(?:test|child)\.mjs$/.test(name)).sort();
  assert.ok(files.includes('index.test.mjs') && files.includes('test-settings.test.mjs'), files.join(', '));
  const without = files.filter(name => firstImport(readFileSync(new URL(name, FOLDER), 'utf8')) !== SETTINGS_IMPORT);
  assert.deepEqual(without, [], `these files do not import ./test-settings.mjs first: ${without.join(', ')}`);
  // And the check reads a first import as it should.
  assert.equal(firstImport("// A comment.\nimport assert from 'node:assert/strict';\nimport './test-settings.mjs';\n"), "import assert from 'node:assert/strict';");
  assert.equal(firstImport(`// A comment.\n\n${SETTINGS_IMPORT}\nimport assert from 'node:assert/strict';\n`), SETTINGS_IMPORT);
});

test('the test settings are forced whatever the shell has set: no local .env is loaded, and no real key is used', () => {
  // A process started with settings that look live, as a shell that exports them would start it, loads the settings
  // alone and prints what it then has. The values are made up here.
  const shell = {
    NODE_ENV: 'production', DOTENV_CONFIG_PATH: '.env', DOTENV_CONFIG_QUIET: 'false',
    DATABASE_URL: 'postgres://made-up:live-looking@db.example.invalid/neondb',
    OPENAI_API_KEY: 'sk-made-up-but-live-looking', ANTHROPIC_API_KEY: 'sk-ant-made-up-but-live-looking', GEMINI_API_KEY: 'AIza-made-up-but-live-looking',
  };
  const names = Object.keys(shell);
  const script = `await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./test-settings.mjs', FOLDER))).href)});
console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name] ?? null]))));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...shell }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    NODE_ENV: 'test',
    DOTENV_CONFIG_PATH: fileURLToPath(new URL('./no-settings.env', FOLDER)),
    DOTENV_CONFIG_QUIET: 'true',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb',
    OPENAI_API_KEY: 'test-openai-key',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
  });
  // This process runs with them too.
  for (const name of names) assert.equal(process.env[name], JSON.parse(child.stdout)[name], name);
});
