-- Schema version 24: drop the four unused `sessions_root*` partial indexes (`WHERE parent_session_id IS NULL`).
-- Root filtering checks parent existence (`NOT EXISTS`), so session lists walk `sessions_last`/`sessions_device`/
-- `sessions_project`/`sessions_device_project` instead. Index-only drop, so no reindex.
DROP INDEX IF EXISTS sessions_root;
DROP INDEX IF EXISTS sessions_root_device;
DROP INDEX IF EXISTS sessions_root_project;
DROP INDEX IF EXISTS sessions_root_device_project;
