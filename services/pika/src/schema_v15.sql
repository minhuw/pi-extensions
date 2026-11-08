-- Schema version 15: memory dreaming (see "Dreaming" under "Memory"). A dream consolidates a project scope's notes from
-- the scope's sessions under a lease, and commits its changes as one batch. Not derived: `pika reindex` leaves these
-- tables alone, so no reindex.

-- What each note's latest revision, and each revision, rests on: a JSON array of `{ sessionId, seq }`.
ALTER TABLE memory_notes ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
-- Who wrote the revision (`agent`, `dream`, or `owner`), its sources, and the dream batch that wrote it, if any.
ALTER TABLE memory_revisions ADD COLUMN provenance TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE memory_revisions ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memory_revisions ADD COLUMN batch_id TEXT;
CREATE INDEX memory_revisions_batch ON memory_revisions(batch_id) WHERE batch_id IS NOT NULL;

-- A dream lease on a scope. It is live until `released_at` is set or `expires_at` passes. `sessions` is the JSON
-- snapshot of the sessions it was granted with: `[{ id, fromSeq, toSeq }]`.
CREATE TABLE memory_dream_leases (
    id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    mode TEXT NOT NULL,
    device_id TEXT NOT NULL,
    session_id TEXT,
    granted_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    released_at INTEGER,
    outcome TEXT,
    sessions TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX memory_dream_leases_scope ON memory_dream_leases(scope_key, granted_at);

-- One committed dream. `sessions` is the JSON array of the session ids whose checkpoints it advanced, `changes` the
-- JSON array of the revisions it wrote, in order: `[{ noteId, revision, action, title, created }]`.
CREATE TABLE memory_dream_batches (
    id TEXT PRIMARY KEY,
    lease_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    mode TEXT NOT NULL,
    at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    session_id TEXT,
    dream_session_id TEXT,
    summary TEXT,
    sessions TEXT NOT NULL,
    changes TEXT NOT NULL,
    reverted_at INTEGER
) WITHOUT ROWID;
CREATE INDEX memory_dream_batches_scope ON memory_dream_batches(scope_key, at);

-- Per scope and session, the highest entry seq a dream consolidated. No row means -1.
CREATE TABLE memory_checkpoints (
    scope_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (scope_key, session_id)
) WITHOUT ROWID;
CREATE INDEX memory_checkpoints_session ON memory_checkpoints(session_id);
