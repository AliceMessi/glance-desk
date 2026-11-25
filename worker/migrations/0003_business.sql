-- Telegram Business: a paired person with Telegram Premium connects the bot to their account
-- (Settings > Telegram Business > Chatbots). Replies to their private client chats then go out as them.
CREATE TABLE business_connections (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  can_reply INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Set for chats that come from a business connection (chat_id is then 'biz:<connection>:<telegram chat id>').
ALTER TABLE chats ADD COLUMN business_connection_id TEXT;
