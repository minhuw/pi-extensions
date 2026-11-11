-- Schema version 21: pika nodes (see `docs/NODE.md`). One row per node credential; only the credential's SHA-256 is
-- stored. `last_host` and `public_key` come from the node's latest `hello` and are for display only. Revoking deletes
-- the row. Not derived: `pika reindex` leaves it alone, so no reindex.
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    last_host TEXT,
    public_key TEXT
) WITHOUT ROWID;
