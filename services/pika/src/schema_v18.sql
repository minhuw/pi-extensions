-- Schema version 18: persistent relay state (see `docs/RELAY.md`). Chatrooms, their members and representatives,
-- recent room messages, the dashboard's recent relay events, and unexpired mailbox messages survive server restarts.
-- Not derived: `pika reindex` leaves these tables alone, so no reindex.

-- An explicit multi-agent chatroom. `next_seq` is the monotonic sequence number of the room's next message.
CREATE TABLE relay_rooms (
    name TEXT PRIMARY KEY,
    topic TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    representative TEXT,
    next_seq INTEGER NOT NULL
) WITHOUT ROWID;

-- A member of a chatroom, with its last-seen metadata; live online state is overlaid in memory.
CREATE TABLE relay_room_members (
    room TEXT NOT NULL,
    session_id TEXT NOT NULL,
    device TEXT,
    name TEXT,
    title TEXT,
    project TEXT,
    model TEXT,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room, session_id)
) WITHOUT ROWID;

-- Bounded recent transcript of a chatroom (`seq` is monotonic per room). `from_json` and `notified_json` store raw
-- device ids so `deviceName` resolves dynamically after device renames.
CREATE TABLE relay_room_messages (
    room TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    from_json TEXT NOT NULL,
    text TEXT NOT NULL,
    mentions_json TEXT NOT NULL,
    notified_json TEXT NOT NULL,
    urgent INTEGER NOT NULL,
    reply_to TEXT,
    hops INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (room, seq)
) WITHOUT ROWID;

-- Bounded ring of recent relay events for the dashboard, ordered by `seq`.
CREATE TABLE relay_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    at INTEGER NOT NULL,
    from_json TEXT NOT NULL,
    to_json TEXT NOT NULL,
    room TEXT,
    mentions_json TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    delivered_at INTEGER,
    urgent INTEGER NOT NULL,
    reply_to TEXT,
    hops INTEGER NOT NULL,
    text TEXT NOT NULL
);

-- Unexpired unacknowledged mailbox messages, ordered by `seq` so delivery order holds across restarts.
CREATE TABLE relay_mailbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    from_json TEXT NOT NULL,
    to_json TEXT NOT NULL,
    room TEXT,
    mentions_json TEXT NOT NULL,
    text TEXT NOT NULL,
    urgent INTEGER NOT NULL,
    reply_to TEXT,
    hops INTEGER NOT NULL,
    sent_at INTEGER NOT NULL
);
