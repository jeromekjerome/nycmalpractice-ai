import './app.test.mjs';
import './ai-budget.test.mjs';
import './backup.test.mjs';
import './models.test.mjs';
import './model-shaping.test.mjs';
import './prices.test.mjs';

import { run } from './runner.mjs';

run().catch(() => {});