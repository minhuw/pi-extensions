-- Schema version 6: a captured request's timing. No derived tables change.

-- `timing` is the request's valid `timing` keys as a JSON object (`sentAt`, `responseAt`, `firstTokenAt`, and
-- `firstToken`; see the spec's "requests"), or NULL when it had none. Requests from before this version have none.
ALTER TABLE requests ADD COLUMN timing TEXT;
