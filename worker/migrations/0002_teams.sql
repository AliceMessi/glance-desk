-- Teams: several paired people can watch the same group (chats.user_id stays as who watched it first).
CREATE TABLE chat_members (
  chat_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
INSERT INTO chat_members (chat_id, user_id, created_at) SELECT chat_id, user_id, created_at FROM chats;
CREATE INDEX chat_members_user ON chat_members(user_id);

-- Who is answering a thread right now. One row per chat, so it survives re-triage of the card.
CREATE TABLE claims (
  chat_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Who sent or closed a card, so a teammate is told "Nina already answered".
ALTER TABLE cards ADD COLUMN handled_by INTEGER;
