-- Schema version 22: Deck's project presentation (see "Deck" in `docs/SPEC.md`). One row per project key the owner
-- named or collapsed; a key without a row has the defaults (no name, expanded). `updated_at` is Unix milliseconds. Not
-- derived: `pika reindex` leaves it alone, so no reindex.
CREATE TABLE deck_projects (
    key TEXT PRIMARY KEY,
    name TEXT,
    collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;
