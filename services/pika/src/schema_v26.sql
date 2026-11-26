-- Schema version 26: memory tiers (`pinned` / `archival`) and memory full-text index (`memory_notes_fts`).
-- No existing derived rows change, so no reindex.

ALTER TABLE memory_notes ADD COLUMN tier TEXT NOT NULL DEFAULT 'pinned' CHECK (tier IN ('pinned', 'archival'));
ALTER TABLE memory_revisions ADD COLUMN tier TEXT NOT NULL DEFAULT 'pinned' CHECK (tier IN ('pinned', 'archival'));

-- Not derived: `pika reindex` leaves memory_notes_fts alone.
CREATE VIRTUAL TABLE memory_notes_fts USING fts5(
    note_id UNINDEXED,
    title,
    hook,
    body,
    tokenize = "pika_cjk remove_diacritics 2 categories 'L* N* Co So'"
);

INSERT INTO memory_notes_fts (note_id, title, hook, body)
SELECT id, title, hook, body FROM memory_notes WHERE deleted_at IS NULL;
