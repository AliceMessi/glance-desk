-- Glance Desk schema (Cloudflare D1)

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE pair_codes (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Only the SHA-256 of the device token is stored.
CREATE TABLE devices (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- A group the owner asked the bot to watch (/watch). One owner per chat.
CREATE TABLE chats (
  chat_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  from_name TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  triaged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_chat ON messages(chat_id, triaged);

-- One open card per chat; re-triaged when new messages arrive.
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  category TEXT NOT NULL,
  urgency INTEGER NOT NULL,
  summary TEXT NOT NULL,
  snippet TEXT NOT NULL,
  from_name TEXT NOT NULL,
  drafts TEXT NOT NULL,
  source TEXT NOT NULL,
  reply_to INTEGER NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  later_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cards_user ON cards(user_id, status);

-- Daily counters: LLM calls (free tier budget) and pairing attempts per IP.
CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
