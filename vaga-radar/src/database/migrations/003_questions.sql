CREATE TABLE IF NOT EXISTS bot_questions (
  id TEXT PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id),
  topic TEXT NOT NULL,
  text TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  notification_status TEXT NOT NULL DEFAULT 'pending',
  notification_id TEXT,
  notification_error TEXT
);
CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages (
  message_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
