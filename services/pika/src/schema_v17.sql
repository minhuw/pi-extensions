-- Schema version 17: when a note was last used (see "Memory"). `POST memory/used` sets it to the server's time, without
-- a revision or history row, so stale notes can be found. Not derived: `pika reindex` leaves it alone, so no reindex.
-- Existing notes have none.
ALTER TABLE memory_notes ADD COLUMN last_used_at INTEGER;
