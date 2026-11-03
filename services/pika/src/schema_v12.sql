-- How a usage event's cost was found (`crate::pricing`): 0 recorded with the usage; 1 estimated by pika from model
-- prices, for a Magpie call that used tokens but recorded no cost; 2 such a call without a known price, whose cost
-- stays 0. Existing calls without a recorded cost wait for prices, which `serve` applies when it loads them.
ALTER TABLE usage_events ADD COLUMN pricing INTEGER NOT NULL DEFAULT 0;
UPDATE usage_events SET pricing = 2
WHERE requests = 1 AND cost = 0 AND input + output + cache_read + cache_write > 0
    AND EXISTS (SELECT 1 FROM model_calls m WHERE m.sid = usage_events.sid AND m.seq = usage_events.seq AND m.provider = 'magpie');
CREATE INDEX usage_events_pricing ON usage_events(sid, seq) WHERE pricing != 0;
