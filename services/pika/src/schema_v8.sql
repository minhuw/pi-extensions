-- Schema version 8: a session's repository. Clients send a session's repository name (`project`) and web URL
-- (`repository`) in its stream's `meta`, which `streams` already keeps, and derivation prefers that name for
-- `sessions.project`. Older clients sent neither, so existing rows keep their values; opening the database re-derives
-- only the sessions whose stored `meta` has either field (see `store::migrate`).
ALTER TABLE sessions ADD COLUMN repository TEXT;
