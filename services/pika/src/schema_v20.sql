-- Schema version 20: swarm boards (see "Boards" in `docs/RELAY.md`). One kanban board per coordinator session, the
-- latest full snapshot its device uploaded, with the snapshot's own `updated_at` (client milliseconds) to drop stale
-- uploads. `device` is the device that owns the session. Not derived: `pika reindex` leaves it alone, so no reindex.
CREATE TABLE relay_boards (
    session_id TEXT PRIMARY KEY,
    device TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    cards_json TEXT NOT NULL
) WITHOUT ROWID;
