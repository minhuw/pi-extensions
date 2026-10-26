-- Schema version 3: no table changes. Displayed extension messages (`custom_message` with `display: true`) that start
-- a run while the session is idle now start turns, so opening a database with data from an earlier version reindexes it.
SELECT 1;
