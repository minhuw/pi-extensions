-- Schema version 2: read API indexes and full-text search. Opening a version 1 database with data reindexes it.

-- The session list filters by any combination of device, project, and root, newest first; with v1's indexes every
-- combination has an index that matches its equality filters and the order.
CREATE INDEX sessions_device_project ON sessions(device, project, last_at DESC, id DESC);
CREATE INDEX sessions_root_device ON sessions(device, last_at DESC, id DESC) WHERE parent_session_id IS NULL;
CREATE INDEX sessions_root_project ON sessions(project, last_at DESC, id DESC) WHERE parent_session_id IS NULL;
CREATE INDEX sessions_root_device_project ON sessions(device, project, last_at DESC, id DESC)
    WHERE parent_session_id IS NULL;

-- Derived: searchable text of session entries, capped per kind (see derive/search.rs). `kind` is user, assistant,
-- tool-call, tool-result, or title. `id` orders documents by time: the entry's Unix second in the high 32 bits, then
-- the session's sid and the entry's seq, so newest-first search reads the index in rowid order.
CREATE TABLE search_docs (
    id INTEGER PRIMARY KEY,
    sid INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER,
    text TEXT NOT NULL
);

-- External content: the index holds no copy of the text; snippets read it from search_docs.
CREATE VIRTUAL TABLE search_fts USING fts5(
    text,
    content = 'search_docs',
    content_rowid = 'id',
    tokenize = "unicode61 remove_diacritics 2 categories 'L* N* Co So'"
);
