DROP TABLE IF EXISTS meetings;

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  host_name TEXT NOT NULL,
  summary JSON,
  created_at INTEGER DEFAULT (unixepoch())
);