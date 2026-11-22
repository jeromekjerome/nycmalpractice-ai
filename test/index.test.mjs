import './test-settings.mjs';
import './app.test.mjs';
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

import { run } from './runner.mjs';

run().catch(() => {});