import './test-settings.mjs';
import './app.test.mjs';
import './requirements.test.mjs';
import './courtlistener-usage.test.mjs';
import './case-library.test.mjs';
import './statute-watch.test.mjs';
import './opinion-list.test.mjs';
import './law-file.test.mjs';
import './lead-preview.test.mjs';
import './law-register.test.mjs';
import './law-citations.test.mjs';
import './statute-text.test.mjs';
import './law.test.mjs';
import './ai-budget.test.mjs';
import './backup.test.mjs';
import './models.test.mjs';
import './providers.test.mjs';
import './provider-anthropic.test.mjs';
import './provider-google.test.mjs';
import './provider-state.test.mjs';
import './model-watch.test.mjs';
import './model-settings.test.mjs';
import './job-schemas.test.mjs';
import './prices.test.mjs';
import './measure.test.mjs';
import './measure-tools.test.mjs';
import './probe-shapes.test.mjs';
import './measure-app.test.mjs';
import './test-settings.test.mjs';
import './library-refresh.test.mjs';
import './case-screen.test.mjs';

import { run } from './runner.mjs';

// A test that never settles would let the process end with exit code 0 and the tests after it never run.
let settled = false;
process.on('exit', () => {
  if (!settled) {
    console.error('The unit suite ended before every test had run.');
    process.exitCode = 1;
  }
});
run().catch(() => {}).finally(() => { settled = true; });