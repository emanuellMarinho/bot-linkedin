CREATE TABLE IF NOT EXISTS submission_attempts (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  provider TEXT NOT NULL,
  board TEXT NOT NULL,
  posting_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sending','submitted','failed','rate_limited','ambiguous')),
  provider_application_id TEXT,
  error_code TEXT,
  retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS submission_identity ON submission_attempts(provider,board,posting_id);
