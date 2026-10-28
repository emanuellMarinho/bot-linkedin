ALTER TABLE bot_questions ADD COLUMN notification_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_questions ADD COLUMN notification_next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_questions ADD COLUMN notification_config_hash TEXT;
ALTER TABLE bot_questions ADD COLUMN notification_recipient TEXT;
ALTER TABLE bot_questions ADD COLUMN notification_phone_number_id TEXT;
ALTER TABLE bot_questions ADD COLUMN notification_status_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_questions ADD COLUMN notification_delivered_at TEXT;
ALTER TABLE bot_questions ADD COLUMN notification_read_at TEXT;
ALTER TABLE bot_questions ADD COLUMN notification_provider_code TEXT;
CREATE INDEX IF NOT EXISTS bot_question_notification_id ON bot_questions(notification_id);
-- Delivery callbacks can reach the receiver before POST /messages returns.
CREATE TABLE IF NOT EXISTS whatsapp_status_events (
  message_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  phone_number_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  error_code TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(message_id,recipient,phone_number_id,status)
);

-- A receipt from POST /messages proves acceptance, not delivery to a phone.
UPDATE bot_questions SET notification_status='accepted' WHERE notification_status='sent';
-- Earlier versions classified even definite rejections as ambiguous. Those
-- requests were not accepted by Meta and can be retried after reconfiguration.
UPDATE bot_questions SET notification_status='failed'
  WHERE notification_status='ambiguous' AND notification_error IN ('AUTHORIZATION','CONFIGURATION','REJECTED');
UPDATE bot_questions SET notification_status='pending'
  WHERE notification_status='ambiguous' AND notification_error='RATE_LIMIT';
