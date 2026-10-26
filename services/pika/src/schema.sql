-- Schema version 1. Source tables hold what devices sent; derived tables are rebuilt from them by `pika reindex`.
-- Times are Unix milliseconds unless a column says otherwise. `seq` is the 0-based line index within a stream
-- (the session header is seq 0); `offset` is the line's byte offset in the source file.

CREATE TABLE settings (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID;

-- Only the SHA-256 (hex) of each device token is stored.
CREATE TABLE tokens (
    name TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Source: one row per uploaded stream (`session:<id>` or `herder:<runId>`).
CREATE TABLE streams (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    device TEXT NOT NULL,
    path TEXT,
    meta TEXT,
    length INTEGER NOT NULL DEFAULT 0,
    line_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Source: verbatim lines without the trailing newline. Lines over 1 MiB live in the blob store and `data` is NULL.
CREATE TABLE lines (
    stream_id INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    data TEXT,
    blob TEXT
);
CREATE UNIQUE INDEX lines_position ON lines(stream_id, offset);

-- Source: blobs present in the blob store (request blocks and large lines).
CREATE TABLE blobs (
    hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    stored INTEGER NOT NULL
) WITHOUT ROWID;

-- Source: model requests. Block hashes are numbered per session in `request_dict`, and `skeleton` refers to them by
-- number (see requests.rs), so a growing context costs only its new blocks.
CREATE TABLE request_sessions (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE
);
CREATE TABLE request_dict (
    rs INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    hash BLOB NOT NULL,
    PRIMARY KEY (rs, idx)
) WITHOUT ROWID;
CREATE UNIQUE INDEX request_dict_hash ON request_dict(rs, hash);
CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    rs INTEGER NOT NULL,
    device TEXT NOT NULL,
    seq INTEGER,
    at TEXT,
    at_ms INTEGER,
    fidelity TEXT NOT NULL,
    provider TEXT,
    api TEXT,
    model TEXT,
    assistant_ts INTEGER,
    response_id TEXT,
    skeleton TEXT NOT NULL,
    block_count INTEGER NOT NULL,
    complete INTEGER NOT NULL,
    received_at INTEGER NOT NULL
);
CREATE INDEX requests_assistant ON requests(session_id, assistant_ts);
CREATE TABLE request_missing (
    hash TEXT NOT NULL,
    request_id TEXT NOT NULL,
    PRIMARY KEY (hash, request_id)
) WITHOUT ROWID;
CREATE INDEX request_missing_request ON request_missing(request_id);

-- Source: Herder goal and plan documents, upserted by key.
CREATE TABLE documents (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    run_id TEXT,
    content TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    device TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX documents_run ON documents(run_id);

-- Derived: one row per session stream; `sid` is `streams.id`. durationMs is `last_at - started_at`.
CREATE TABLE sessions (
    sid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    device TEXT NOT NULL,
    cwd TEXT,
    project TEXT,
    title TEXT,
    name TEXT,
    first_prompt TEXT,
    version INTEGER,
    started_at INTEGER,
    last_at INTEGER NOT NULL DEFAULT 0,
    entry_count INTEGER NOT NULL DEFAULT 0,
    turn_count INTEGER NOT NULL DEFAULT 0,
    models TEXT NOT NULL DEFAULT '[]',
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    header_parent TEXT,
    parent_session_id TEXT,
    link TEXT,
    herder_run_id TEXT,
    child_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_last ON sessions(last_at DESC, id DESC);
CREATE INDEX sessions_root ON sessions(last_at DESC, id DESC) WHERE parent_session_id IS NULL;
CREATE INDEX sessions_device ON sessions(device, last_at DESC, id DESC);
CREATE INDEX sessions_project ON sessions(project, last_at DESC, id DESC);
CREATE INDEX sessions_parent ON sessions(parent_session_id);
CREATE INDEX sessions_herder ON sessions(herder_run_id);

CREATE TABLE session_models (
    model TEXT NOT NULL,
    sid INTEGER NOT NULL,
    PRIMARY KEY (model, sid)
) WITHOUT ROWID;

-- Derived: the session's link, from its first `pi-extensions.session-link` entry (source 'entry') or else the
-- header's `parentSession` (source 'header').
CREATE TABLE session_links (
    sid INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    seq INTEGER,
    kind TEXT,
    parent_session_id TEXT,
    parent_session_file TEXT,
    parent_tool_call_id TEXT,
    agent_id TEXT,
    parent_agent_id TEXT,
    workflow_id TEXT,
    agent_type TEXT,
    description TEXT,
    herder_run_id TEXT,
    herder_step_key TEXT,
    herder_step_id TEXT,
    herder_role TEXT,
    herder_attempt INTEGER,
    herder_launch INTEGER,
    data TEXT
);
CREATE INDEX session_links_parent ON session_links(parent_session_id);
CREATE INDEX session_links_herder ON session_links(herder_run_id, herder_step_key);

-- Derived: one row per line. `turn` is the user-prompt index (NULL before the first prompt). `role` is the message
-- role for message entries; `tool_call_ids` is a JSON array.
CREATE TABLE entries (
    sid INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    entry_id TEXT,
    parent_id TEXT,
    type TEXT NOT NULL,
    role TEXT,
    custom_type TEXT,
    ts INTEGER,
    tool_call_ids TEXT,
    turn INTEGER,
    PRIMARY KEY (sid, seq)
) WITHOUT ROWID;

-- Derived: one row per user prompt, or per displayed extension message that starts a run while idle. `at` is the prompt's entry time; usage sums every usage source in the turn.
CREATE TABLE turns (
    sid INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    start_seq INTEGER NOT NULL,
    end_seq INTEGER NOT NULL,
    user_text TEXT NOT NULL,
    at INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    model_calls INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    tool_errors INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    final_text TEXT,
    PRIMARY KEY (sid, idx)
) WITHOUT ROWID;

-- Derived: one row per assistant message. `ts` is the message's `timestamp`, `at` the entry's.
CREATE TABLE model_calls (
    sid INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    entry_id TEXT,
    turn INTEGER,
    ts INTEGER,
    at INTEGER,
    provider TEXT,
    model TEXT,
    api TEXT,
    stop_reason TEXT,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    response_id TEXT,
    error_message TEXT,
    request_id TEXT,
    PRIMARY KEY (sid, seq)
) WITHOUT ROWID;
CREATE INDEX model_calls_ts ON model_calls(sid, ts);
CREATE INDEX model_calls_request ON model_calls(request_id) WHERE request_id IS NOT NULL;

-- Derived: one row per tool call id. Times are entry times; `output_size` is the result content's size in bytes.
CREATE TABLE tool_calls (
    sid INTEGER NOT NULL,
    call_id TEXT NOT NULL,
    name TEXT,
    arguments TEXT,
    turn INTEGER,
    call_seq INTEGER,
    result_seq INTEGER,
    is_error INTEGER,
    started_at INTEGER,
    ended_at INTEGER,
    duration_ms INTEGER,
    output_size INTEGER,
    PRIMARY KEY (sid, call_id)
) WITHOUT ROWID;
CREATE INDEX tool_calls_seq ON tool_calls(sid, call_seq);

-- Derived: Herder runs from `herder-journal` streams; `rid` is `streams.id`. `status` follows Herder's fold:
-- the run.finished status, else delivered, approved, or drafting.
CREATE TABLE herder_runs (
    rid INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    device TEXT NOT NULL,
    repo TEXT,
    repo_path TEXT,
    title TEXT,
    base TEXT,
    session_id TEXT,
    status TEXT NOT NULL,
    verdict TEXT,
    goal_sha256 TEXT,
    plan_sha256 TEXT,
    goal_approved INTEGER NOT NULL DEFAULT 0,
    delivered INTEGER NOT NULL DEFAULT 0,
    finished_status TEXT,
    started_at INTEGER,
    last_at INTEGER NOT NULL DEFAULT 0,
    event_count INTEGER NOT NULL DEFAULT 0,
    step_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX herder_runs_last ON herder_runs(last_at DESC, run_id DESC);

CREATE TABLE herder_events (
    rid INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    t TEXT,
    at INTEGER,
    PRIMARY KEY (rid, seq)
) WITHOUT ROWID;

-- Derived: the latest state of each step key. `first_seq` orders steps by first appearance.
CREATE TABLE herder_steps (
    rid INTEGER NOT NULL,
    key TEXT NOT NULL,
    id TEXT,
    task TEXT,
    role TEXT,
    label TEXT,
    phase TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    launch INTEGER,
    session_id TEXT,
    session_file TEXT,
    commit_sha TEXT,
    error TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    first_seq INTEGER NOT NULL,
    PRIMARY KEY (rid, key)
) WITHOUT ROWID;
CREATE INDEX herder_steps_order ON herder_steps(rid, first_seq);
