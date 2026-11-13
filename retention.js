// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import sql from './db.js';

// The privacy policy (public/privacy.html, "Data Retention") promises that a conversation is kept for
// 90 days after the visitor's last message and then deleted. Lead records sold to law firms (auctions
// and leads) are kept for 3 years under the same policy and are not touched here.
export const CONVERSATION_RETENTION_DAYS = 90;

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
