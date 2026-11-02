-- Schema version 10: deleting and hiding sessions. No existing derived rows change, so no reindex.

-- Tombstones: the stream key (`session:<id>` or `herder:<runId>`) of every deleted stream. Ingest accepts and discards
-- later lines of these streams, requests of deleted sessions, and documents of deleted Herder runs, so a client that
-- keeps uploading cannot bring them back. Not derived: `pika reindex` leaves it alone.
CREATE TABLE deleted_streams (
    key TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
) WITHOUT ROWID;

-- The sessions the owner hid from the public view, by session id. Not derived: `pika reindex` leaves it alone.
CREATE TABLE hidden_sessions (
    id TEXT PRIMARY KEY,
    hidden_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Derived: the sid of every session that is hidden or has a hidden recorded ancestor, from `hidden_sessions` and the
-- parent links, so the public namespace filters them in SQL. Kept small: only hidden sessions have a row.
CREATE TABLE session_hidden (sid INTEGER PRIMARY KEY);

-- Deleting sessions finds their search documents, and checks whether a blob is still referenced, by index.
CREATE INDEX search_docs_sid ON search_docs(sid);
CREATE INDEX lines_blob ON lines(blob) WHERE blob IS NOT NULL;
CREATE INDEX request_dict_blob ON request_dict(hash);
