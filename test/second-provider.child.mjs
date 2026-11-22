// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Run only as a child process of test/app.test.mjs (inSecondProviderChild), never on its own:
//   node test/second-provider.child.mjs <hung-openai | mixed-provenance>
//
// The suite's own process keeps ANTHROPIC_API_KEY empty, so that no test asks Claude by accident, and providers.js makes
// its adapters once. A reply that Claude answers through the app's own wiring therefore needs a process of its own. The
// parent hands this one the suite's made-up settings and no mail login; the test settings, imported first, point dotenv
// at an empty file and blank the model keys, and this file then gives Claude a made-up key of its own. Before anything
// of the app is loaded, every outbound request is answered here: OpenAI and Anthropic as the scenario says,
// CourtListener with no decisions, the database with no rows. Anything else throws, so nothing reaches a network. It
// prints one line, RESULT and the scenario's findings as JSON.
import './test-settings.mjs';
import net from 'node:net';

// A made-up key, so that Claude's adapter is made. Refused when the parent left a mail login: nothing here sends mail.
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
if (process.env.SMTP_USER) {
  console.error('second-provider.child.mjs runs only as a child of test/app.test.mjs, with no mail login.');
  process.exit(2);
}

// Nor does anything leave this machine by a route other than fetch (mail, text messages, a library's own client):
// every connection goes through net.Socket's connect, which here refuses any address but this machine's.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function onlyOnThisMachine(...args) {
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  const options = first !== null && typeof first === 'object' ? first : { port: first, host: typeof second === 'string' ? second : undefined };
  const host = options.host ?? options.hostname;
  if (!options.path && ![undefined, 'localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`Unexpected outbound connection in the child: ${host}`);
  }
  return connect.apply(this, args);
};

const DISCLAIMER = 'This is general information, not legal advice.';
const DRAFT = `I am so sorry this happened. When was the surgery? ${DISCLAIMER}`;
const CLASSIFICATION = JSON.stringify({ type: 'surgical_error', terms: 'retained surgical sponge' });
const EMPTY_ROWS = { fields: [], rows: [], command: 'SELECT', rowCount: 0, rowAsArray: true };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const openaiAnswer = (model, content) => json({
  id: 'chatcmpl-child', object: 'chat.completion', created: 0, model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const anthropicAnswer = (model, text) => json({
  id: 'msg_child', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
});

// A request the provider takes and never answers, until the request's own signal fires at its time limit.
function neverAnswered(call, init) {
  return new Promise((_, reject) => {
    const signal = init.signal;
    if (!signal) return setTimeout(() => reject(new Error('no signal was given')), 5_000);
    signal.addEventListener('abort', () => { call.aborted = true; reject(signal.reason); }, { once: true });
  });
}

const scenario = process.argv[2];
// Each model request, by provider, model and job (the measurement's jobOf, which reads every provider's shape).
const asked = [];
const statements = [];
let jobOf = () => 'unknown';
let gradeVerdicts = '{}';

const answers = {
  // Every OpenAI request is taken and never answered; Claude answers every job.
  'hung-openai': {
    openai: (call, init) => neverAnswered(call, init),
    anthropic: call => anthropicAnswer(call.model, call.job === 'classify' ? CLASSIFICATION : DRAFT),
  },
  // OpenAI classifies and writes the reply, and answers its grader with a server error; Claude grades.
  'mixed-provenance': {
    openai: call => (call.job === 'grade'
      ? json({ error: { message: 'The server had an error.', type: 'server_error' } }, 500)
      : openaiAnswer(call.model, call.job === 'classify' ? CLASSIFICATION : DRAFT)),
    anthropic: call => anthropicAnswer(call.model, call.job === 'grade' ? gradeVerdicts : DRAFT),
  },
};
if (!Object.hasOwn(answers, scenario)) {
  console.error(`second-provider.child.mjs: no scenario named ${scenario}`);
  process.exit(2);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
  for (const [provider, host] of [['openai', 'https://api.openai.com/'], ['anthropic', 'https://api.anthropic.com/']]) {
    if (!url.startsWith(host)) continue;
    const body = JSON.parse(String(init.body ?? '{}'));
    const call = { provider, model: body.model, job: jobOf(body), aborted: false };
    asked.push(call);
    return answers[scenario][provider](call, init);
  }
  if (url.startsWith('https://www.courtlistener.com/')) return json({ results: [] });
  if (url.endsWith('/sql')) {
    const body = JSON.parse(String(init.body));
    statements.push(body);
    return Array.isArray(body.queries) ? json({ results: body.queries.map(() => EMPTY_ROWS) }) : json(EMPTY_ROWS);
  }
  throw new Error(`Unexpected outbound request in the child: ${url}`);
};

// Only now is anything of the app loaded.
({ jobOf } = await import('../measure/app.mjs'));
const { loadRubric } = await import('../gatekeeper.js');
const rubric = loadRubric('personal');
gradeVerdicts = JSON.stringify({
  required_checks: rubric.required_criteria.map(c => ({ id: c.id, name: c.name, passed: true, evidence_or_gap: 'Satisfied.' })),
  prohibited_checks: rubric.prohibited_criteria.map(c => ({ id: c.id, name: c.name, violated: false, offending_quote: 'None', remediation_instruction: '' })),
  coaching: 'No changes needed.',
});

// The app writes to the console as it works; the parent reads only the RESULT line. The process then ends once the
// sockets and timers of the run have closed: an exit while a socket is still closing trips an assertion in Node on
// Windows. Whatever stays open past a quarter of a second does not hold the process.
const print = findings => {
  console.log(`RESULT ${JSON.stringify(findings)}`);
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 250).unref();
};

if (scenario === 'hung-openai') {
  // The built-in chains, and a clock that gives every model call 300 ms.
  const { answerUserQuestion } = await import('../ask.js');
  const { replyClock } = await import('../providers.js');
  const started = Date.now();
  const clock = replyClock({ deadlineAt: started + 10_000, limitFor: () => 300 });
  const result = await answerUserQuestion({ question: 'A sponge was left inside me after surgery.', mode: 'personal', sessionId: 'child-hung-openai', history: [], clock });
  print({ ms: Date.now() - started, answer: result.answer, writtenBy: result.evaluation?.writtenBy ?? null, demoted: clock.demoted('openai'), asked });
} else {
  // The site itself, with the built-in chains: /api/ask, and the conversation as it is saved.
  const { default: app } = await import('../server.js');
  const { startServer } = await import('./helpers.mjs');
  const server = await startServer(app);
  const response = await fetch(`${server.baseUrl}/api/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'A sponge was left inside me after surgery.', mode: 'personal', sessionId: 'child-mixed-provenance', history: [] }),
  });
  const body = await response.json();
  await server.close();
  const saved = statements.find(statement => /^INSERT INTO conversations \(session_id, mode/.test(String(statement.query ?? '').replace(/\s+/g, ' ').trim()));
  const audit = saved ? JSON.parse(saved.params.find(param => typeof param === 'string' && param.includes('"gate_status"'))) : null;
  print({ status: response.status, evaluation: body.evaluation ?? null, writtenBy: audit?.writtenBy ?? null, gradedBy: audit?.gradedBy ?? null, asked });
}
