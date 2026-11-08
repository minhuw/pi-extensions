-- Schema version 14: agent memory (see "Memory"). Notes that pi agents save per user and per project, with the history
-- of every save and forget. Not derived: `pika reindex` leaves these tables alone, so no reindex.

-- A memory scope: `user`, `repo:<normalized repository URL>`, or `local:<project>@<device id>`. `label` is the project
-- name (`user` for the user scope), which deleting a project matches.
CREATE TABLE memory_scopes (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX memory_scopes_label ON memory_scopes(label);

-- A note's current state. A forgotten note keeps its row, with `deleted_at` set.
CREATE TABLE memory_notes (
    id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL REFERENCES memory_scopes(key),
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    body TEXT NOT NULL,
    provenance TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    device_id TEXT,
    session_id TEXT
) WITHOUT ROWID;
CREATE INDEX memory_notes_scope ON memory_notes(scope_key, deleted_at);

-- One row per save and forget of a note: the note as that revision left it.
CREATE TABLE memory_revisions (
    note_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    action TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    body TEXT NOT NULL,
    at INTEGER NOT NULL,
    device_id TEXT,
    session_id TEXT,
    reason TEXT,
    PRIMARY KEY (note_id, revision)
) WITHOUT ROWID;
