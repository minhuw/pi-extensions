-- Schema version 16: idempotent dream commits (see "Dreaming" under "Memory"). A commit may name a `commitId`; a retry
-- with the same one under the same lease answers the batch the first try recorded instead of applying it again. Not
-- derived: `pika reindex` leaves it alone, so no reindex. Existing batches have none.
ALTER TABLE memory_dream_batches ADD COLUMN commit_id TEXT;
CREATE UNIQUE INDEX memory_dream_batches_commit ON memory_dream_batches(lease_id, commit_id) WHERE commit_id IS NOT NULL;
-- Whether a lease committed anything: an `auto` lease released `aborted` without a batch leaves the daily quota alone.
CREATE INDEX memory_dream_batches_lease ON memory_dream_batches(lease_id);
