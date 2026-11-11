-- Schema version 19: indexes for the owner's extension usage aggregate (`GET extension-usage`): command entries by
-- custom type and time, and tool calls by start time. Both columns are already derived, so no reindex.
CREATE INDEX entries_custom_type ON entries(custom_type, ts);
CREATE INDEX tool_calls_started ON tool_calls(started_at);
