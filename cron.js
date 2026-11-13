// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import cron from 'node-cron';
import { neon } from '@neondatabase/serverless';
import { closeAuction } from './auction.js';
import { recordDecline, resetDeclineCounts } from './firms.js';
import { purgeExpiredConversations } from './retention.js';

const sql = neon(process.env.DATABASE_URL);

export function startCronJobs() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const expired = await sql`SELECT id FROM auctions WHERE status = 'open' AND closes_at < NOW()`;
      for (const row of expired) await closeAuction(row.id);
    } catch (err) { console.error('Auction close cron error:', err.message); }
  });

  cron.schedule('0 * * * *', async () => {
    try {
      const overdue = await sql`SELECT id, firm_id, auction_id FROM leads WHERE status = 'pending' AND accept_deadline < NOW()`;
      for (const lead of overdue) {
        await sql`UPDATE leads SET status = 'declined' WHERE id = ${lead.id}`;
        await recordDecline(lead.firm_id, !!lead.auction_id);
      }
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
