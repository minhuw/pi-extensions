-- Schema version 23: narrow partial index for Spokesman's read-time rewrite projection (`read::spokesman::Rewrites::load`).
-- `custom_type` is already derived on `entries`, so no reindex.
CREATE INDEX entries_spokesman ON entries(sid, seq) WHERE custom_type = 'spokesman-rewrite';
