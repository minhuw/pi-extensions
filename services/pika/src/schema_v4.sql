-- Schema version 4: browser sessions, device last-seen columns, and pairings. No derived tables change.

-- Login sessions of the web UI. The cookie holds a random id; only its SHA-256 (hex) is stored. Named
-- `auth_sessions` because `sessions` is the derived table of pi sessions.
CREATE TABLE auth_sessions (
    id_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT,
    ip TEXT
) WITHOUT ROWID;

-- `created_via` is 'cli' or 'pairing'; ingest updates `last_seen_at` and `last_host` at most once a minute.
ALTER TABLE tokens ADD COLUMN created_via TEXT NOT NULL DEFAULT 'cli';
ALTER TABLE tokens ADD COLUMN last_seen_at INTEGER;
ALTER TABLE tokens ADD COLUMN last_host TEXT;

-- Device pairings. `id_hash` is the SHA-256 (hex) of the secret pairing id the device polls with; `code` is the
-- 8-character code without its hyphen. `status` is 'pending', 'approved', or 'denied'; approval records the device
-- `name` and whether to `replace` an existing token. The device token is created when the device polls, so no
-- token is ever stored here.
CREATE TABLE pairings (
    id_hash TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    device TEXT NOT NULL,
    host TEXT,
    ip TEXT,
    pika_version TEXT,
    requested_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    name TEXT,
    replace INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
