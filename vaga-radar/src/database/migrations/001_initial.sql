CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS candidate_profile (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS candidate_skills (name TEXT PRIMARY KEY, verified INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS job_keywords (id INTEGER PRIMARY KEY, group_name TEXT NOT NULL, term TEXT NOT NULL, UNIQUE(group_name,term));
CREATE TABLE IF NOT EXISTS jobs (
 id INTEGER PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL,
 canonical_url TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
 location TEXT, published_at TEXT, collected_at TEXT NOT NULL,
 score INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new',
 data TEXT NOT NULL, matching TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_fingerprint ON jobs(fingerprint);
CREATE INDEX IF NOT EXISTS jobs_search ON jobs(company,title,location);
CREATE INDEX IF NOT EXISTS jobs_published ON jobs(published_at);
CREATE INDEX IF NOT EXISTS jobs_score ON jobs(score);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS sources (
 id INTEGER PRIMARY KEY, provider TEXT NOT NULL, board TEXT NOT NULL, company TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, last_checked TEXT, last_success TEXT, last_error TEXT,
 UNIQUE(provider,board)
);
CREATE TABLE IF NOT EXISTS job_sources (
 id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id),
 provider TEXT NOT NULL, board TEXT NOT NULL DEFAULT '', original_id TEXT,
 original_url TEXT NOT NULL, collected_at TEXT NOT NULL,
 UNIQUE(provider,board,original_id), UNIQUE(job_id,original_url)
);
CREATE TABLE IF NOT EXISTS applications (
 id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
 status TEXT NOT NULL DEFAULT 'new', notes TEXT NOT NULL DEFAULT '',
 resume_id INTEGER, preparation TEXT, sent_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS application_events (
 id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id),
 from_status TEXT, to_status TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_application ON application_events(application_id,created_at);
CREATE TABLE IF NOT EXISTS resumes (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_runs (
 id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
 duration_ms INTEGER, received INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0,
 duplicates INTEGER NOT NULL DEFAULT 0, errors TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
 id INTEGER PRIMARY KEY, type TEXT NOT NULL, message TEXT NOT NULL, job_id INTEGER REFERENCES jobs(id),
 created_at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0
);
