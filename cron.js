// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import cron from 'node-cron';
import { neon } from '@neondatabase/serverless';
import { closeExpiredAuctions, declineOverdueLeads } from './auction.js';
import { resetDeclineCounts } from './firms.js';
import { purgeExpiredConversations } from './retention.js';

const sql = neon(process.env.DATABASE_URL);

export function startCronJobs() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      await closeExpiredAuctions();
    } catch (err) { console.error('Auction close cron error:', err.message); }
  });

  cron.schedule('0 * * * *', async () => {
    try {
      await declineOverdueLeads();
    } catch (err) { console.error('Overdue leads cron error:', err.message); }
  });

  cron.schedule('0 2 * * *', async () => {
    try { await resetDeclineCounts(); }
    catch (err) { console.error('Decline reset cron error:', err.message); }
    try { await purgeExpiredConversations(); }
    catch (err) { console.error('Conversation purge cron error:', err.message); }
  });

  console.log('Cron jobs started');
}
