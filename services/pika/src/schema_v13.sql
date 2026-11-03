-- Schema version 13: agents' read access, a per-device switch (see "Agent read API"). On by default, also for every
-- existing device; the owner turns it off per device. Not derived, so no reindex.
ALTER TABLE devices ADD COLUMN read_access INTEGER NOT NULL DEFAULT 1;
