-- Schema version 5: device ids, names, and keys. No derived tables change.

-- A device's `id` is its identity: the `name` of its token row and the `device` of its streams, requests, documents,
-- sessions, and Herder runs. Devices from before this version keep their name as their id; new ones get a random
-- UUID. `name` is a free display label. `key_hash` is the SHA-256 (hex) of the device key of the pi install it was
-- last paired from. Revoking a device deletes its token only, so this row stays.
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT UNIQUE,
    created_at INTEGER NOT NULL
) WITHOUT ROWID;
INSERT INTO devices (id, name, created_at) SELECT name, name, created_at FROM tokens;
INSERT OR IGNORE INTO devices (id, name, created_at) SELECT device, device, MIN(created_at) FROM streams GROUP BY device;

-- `device` now holds the requested name and `name` the approved one; `replace` is no longer used. `key_hash` is the
-- requesting install's device key hash, `matched` the device the request was recognized as at start (`matched_by`
-- 'token' or 'key'), and `target` the device id approval chose for the token.
ALTER TABLE pairings ADD COLUMN key_hash TEXT;
ALTER TABLE pairings ADD COLUMN matched TEXT;
ALTER TABLE pairings ADD COLUMN matched_by TEXT;
ALTER TABLE pairings ADD COLUMN target TEXT;
