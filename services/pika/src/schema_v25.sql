-- Schema version 25: partial indexes for `memory::dream::scope_sessions` so listing a scope's pending sessions
-- avoids full scans of `session_links` and `sessions`. Index-only addition, so no reindex.
CREATE INDEX session_links_dream ON session_links(sid) WHERE agent_type = 'memory-dream';
CREATE INDEX sessions_repo_last ON sessions(repository, last_at, id) WHERE repository IS NOT NULL;
