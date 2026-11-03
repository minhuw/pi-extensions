-- Derived usage from every source included in session/turn totals. Requests count assistant messages,
-- including failed messages without usage; summary entries contribute usage but no requests.
CREATE TABLE usage_events (
    sid INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    at INTEGER,
    requests INTEGER NOT NULL,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (sid, seq)
) WITHOUT ROWID;
CREATE INDEX usage_events_at ON usage_events(at, sid);
-- Session activity includes entries without usage, without reading source lines at query time.
CREATE INDEX entries_activity ON entries(ts, sid);
