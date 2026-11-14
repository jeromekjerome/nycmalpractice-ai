// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import sql from './db.js';

// The privacy policy (public/privacy.html, "Data Retention"): a conversation is kept for 90 days after the
// visitor's last message and then deleted, and the lead records sold to law firms (leads, and auctions with
// their bids) are kept for 3 years. The lead records used to be kept for good.
export const CONVERSATION_RETENTION_DAYS = 90;
export const LEAD_RETENTION_YEARS = 3;

export async function purgeExpiredConversations() {
  const days = CONVERSATION_RETENTION_DAYS;
  const conversations = await sql`
    DELETE FROM conversations
    WHERE updated_at < NOW() - make_interval(days => ${days})
    RETURNING id`;
  // The message log keeps its counts (mode, case type, lead flag) but not what the visitor wrote.
  const messages = await sql`
    UPDATE user_interactions SET question = NULL
    WHERE question IS NOT NULL AND created_at < NOW() - make_interval(days => ${days})
    RETURNING id`;
  return { conversations: conversations.length, messages: messages.length };
}

export async function purgeExpiredLeadRecords() {
  const years = LEAD_RETENTION_YEARS;
  const leads = await sql`
    DELETE FROM leads
    WHERE created_at < NOW() - make_interval(years => ${years})
    RETURNING id`;
  // An auction goes once no lead refers to it: its winner's lead is younger than the auction itself.
  const bids = await sql`
    DELETE FROM bids
    WHERE auction_id IN (
      SELECT a.id FROM auctions a
      WHERE a.created_at < NOW() - make_interval(years => ${years})
        AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.auction_id = a.id))
    RETURNING id`;
  const auctions = await sql`
    DELETE FROM auctions a
    WHERE a.created_at < NOW() - make_interval(years => ${years})
      AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.auction_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.auction_id = a.id)
    RETURNING id`;
  return { leads: leads.length, auctions: auctions.length, bids: bids.length };
}
