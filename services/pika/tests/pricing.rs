mod common;

use common::*;
use pika::pricing::{self, Price, PriceTable, Rates};
use pika::store::Store;
use serde_json::{Value, json};

const KEY: &str = "session:0c5a7e00-pricing";
/// SQL that removes schema versions 20..=12 for tests that rewind `user_version`.
const UNDO_V12: &str = "DROP TABLE relay_boards; DROP INDEX entries_custom_type; DROP INDEX tool_calls_started; DROP TABLE relay_mailbox; DROP TABLE relay_events; DROP TABLE relay_room_messages; DROP TABLE relay_room_members; DROP TABLE relay_rooms; DROP TABLE memory_checkpoints; DROP TABLE memory_dream_batches; DROP TABLE memory_dream_leases; DROP TABLE memory_revisions; DROP TABLE memory_notes; DROP TABLE memory_scopes; ALTER TABLE devices DROP COLUMN read_access; DROP INDEX usage_events_pricing; ALTER TABLE usage_events DROP COLUMN pricing;";

fn lines(values: &[Value]) -> Vec<String> {
    values.iter().map(Value::to_string).collect()
}

fn prompt(text: &str, at: &str) -> Value {
    json!({ "type": "message", "timestamp": at, "message": { "role": "user", "content": text } })
}

/// A Magpie call; without `cost`, priced as Magpie Provider records a model it has no price for.
fn call(model: &str, input: i64, output: i64, cost: Option<f64>, at: &str) -> Value {
    let cost = match cost {
        Some(total) => json!({ "total": total }),
        None => json!({ "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0, "magpiePricing": "unavailable" }),
    };
    json!({ "type": "message", "timestamp": at, "message": { "role": "assistant", "provider": "magpie", "model": model,
        "content": "ok", "stopReason": "stop",
        "usage": { "input": input, "output": output, "cacheRead": 0, "cacheWrite": 0, "totalTokens": input + output, "cost": cost } } })
}

fn session() -> Vec<String> {
    lines(&[
        json!({ "type": "session", "version": 3, "id": "0c5a7e00-pricing", "timestamp": "2026-11-01T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        prompt("first", "2026-11-01T09:00:01.000Z"),
        call("claude-opus-5-5", 100, 10, Some(1.5), "2026-11-01T09:00:02.000Z"),
        // Pika stores the bare name, `k3.1-pro`.
        call("kimi/k3.1-pro", 1_000_000, 100_000, None, "2026-11-01T09:00:03.000Z"),
        prompt("second", "2026-11-01T09:00:04.000Z"),
        call("mystery-model", 10, 10, None, "2026-11-01T09:00:05.000Z"),
        // A call without tokens, such as a failed request, and summary usage keep their recorded zero.
        call("kimi/k3.1-pro", 0, 0, None, "2026-11-01T09:00:06.000Z"),
        json!({ "type": "compaction", "timestamp": "2026-11-01T09:00:07.000Z", "usage": { "input": 50, "output": 5, "cost": { "total": 0 } } }),
    ])
}

fn prices() -> PriceTable {
    let rates = Rates { input: 2.0, output: 10.0, cache_read: 0.2, cache_write: 2.0 };
    PriceTable::new([("k3.1-pro".to_owned(), Price { rates, tiers: Vec::new() })])
}

fn costs(store: &Store) -> Value {
    let rows = |sql: &str| json!(query(store, sql));
    json!({
        "events": rows("SELECT seq, pricing, cost FROM usage_events ORDER BY seq"),
        "calls": rows("SELECT seq, model, cost FROM model_calls ORDER BY seq"),
        "turns": rows("SELECT idx, cost FROM turns ORDER BY idx"),
        "session": one(store, "SELECT cost FROM sessions")["cost"],
    })
}

fn totals(store: &Store) -> Value {
    let mut params = pika::read::Params::default();
    params.0.insert("days".into(), "all".into());
    let stats = store.read(|conn| pika::read::statistics::statistics(conn, &params)).unwrap();
    let totals = serde_json::to_value(stats).unwrap()["totals"].clone();
    json!({ "cost": totals["cost"], "estimatedCost": totals["estimatedCost"], "unpricedRequests": totals["unpricedRequests"] })
}

fn generation(store: &Store) -> Option<Vec<u8>> {
    store.setting(pika::store::DERIVED_GENERATION).unwrap()
}

#[test]
fn calls_without_a_recorded_cost_take_their_models_price() {
    let env = env();
    let store = &env.store;
    upload(store, KEY, "session", &session(), 3);
    assert_eq!(
        costs(store)["events"],
        json!([
            { "seq": 2, "pricing": 0, "cost": 1.5 },
            { "seq": 3, "pricing": 2, "cost": 0.0 },
            { "seq": 5, "pricing": 2, "cost": 0.0 },
            { "seq": 6, "pricing": 0, "cost": 0.0 },
            { "seq": 7, "pricing": 0, "cost": 0.0 },
        ])
    );
    assert_eq!(totals(store), json!({ "cost": 1.5, "estimatedCost": 0.0, "unpricedRequests": 2 }));

    // New prices reprice the calls that recorded none, and their turns and session, and invalidate cached traces.
    let before = generation(store);
    assert_eq!(store.set_prices(prices()).unwrap(), 1);
    assert_ne!(generation(store), before);
    let priced = costs(store);
    assert_eq!(priced["events"][1], json!({ "seq": 3, "pricing": 1, "cost": 3.0 }));
    assert_eq!(priced["events"][2], json!({ "seq": 5, "pricing": 2, "cost": 0.0 }));
    assert_eq!(priced["calls"][1], json!({ "seq": 3, "model": "k3.1-pro", "cost": 3.0 }));
    assert_eq!(priced["turns"], json!([{ "idx": 0, "cost": 4.5 }, { "idx": 1, "cost": 0.0 }]));
    assert_eq!(priced["session"], json!(4.5));
    assert_eq!(totals(store), json!({ "cost": 4.5, "estimatedCost": 3.0, "unpricedRequests": 1 }));
    // The same prices again change nothing.
    let before = generation(store);
    assert_eq!(store.set_prices(prices()).unwrap(), 0);
    assert_eq!(generation(store), before);

    // Ingest prices new calls as it derives them, into the open turn.
    let more = lines(&[call("k3.1-pro", 500_000, 0, None, "2026-11-01T09:00:08.000Z")]);
    let offset = byte_len(&session());
    ingest(store, json!({ "streams": [stream(KEY, "session", offset, &more)] })).unwrap();
    let ingested = costs(store);
    assert_eq!(ingested["events"][5], json!({ "seq": 8, "pricing": 1, "cost": 1.0 }));
    assert_eq!(ingested["turns"][1], json!({ "idx": 1, "cost": 1.0 }));
    assert_eq!(ingested["session"], json!(5.5));

    // A reindex prices the replayed calls alike.
    let derived = dump_derived(store);
    pika::reindex::reindex(store).unwrap();
    assert_eq!(dump_derived(store), derived);

    // Without prices, only recorded costs count again.
    assert_eq!(store.set_prices(PriceTable::default()).unwrap(), 2);
    let unpriced = costs(store);
    assert_eq!(unpriced["session"], json!(1.5));
    assert_eq!(unpriced["turns"], json!([{ "idx": 0, "cost": 1.5 }, { "idx": 1, "cost": 0.0 }]));
    assert_eq!(totals(store), json!({ "cost": 1.5, "estimatedCost": 0.0, "unpricedRequests": 3 }));
}

#[test]
fn the_upgrade_marks_existing_calls_without_a_reindex() {
    let env = env();
    upload(&env.store, KEY, "session", &session(), 100);
    let events = costs(&env.store)["events"].clone();
    let data = env.dir.path().join("data");
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V12} PRAGMA user_version = 11;")).unwrap();
    drop(conn);

    let store = Store::open(&data).unwrap();
    assert_eq!(one(&store, "PRAGMA user_version")["user_version"], json!(20));
    assert_eq!(costs(&store)["events"], events);
    assert!(store.setting(pika::store::NEEDS_REINDEX).unwrap().is_none());
}

#[test]
fn a_fetched_catalog_prices_calls_and_is_kept_for_a_restart() {
    let env = env();
    upload(&env.store, KEY, "session", &session(), 100);
    let catalog = json!({
        "moonshotai": { "models": { "kimi-k3.1-pro": { "id": "kimi-k3.1-pro", "name": "Kimi K3.1 Pro", "cost": { "input": 2, "output": 10, "cache_read": 0.2, "cache_write": 2 } } } },
        "kimi-code-plan": { "models": { "k3.1-pro": { "id": "k3.1-pro", "name": "Kimi K3.1 Pro", "cost": { "input": 0, "output": 0 } } } },
    });
    let source = env.dir.path().join("api.json");
    std::fs::write(&source, catalog.to_string()).unwrap();
    let source = source.to_str().unwrap();
    assert_eq!(pricing::refresh(&env.store, source).unwrap(), 2);
    assert_eq!(costs(&env.store)["session"], json!(4.5));
    assert!(pricing::refresh(&env.store, &format!("{source}.missing")).is_err());

    // Another process, such as `pika reindex` beside the server, prices with the kept prices.
    let data = env.dir.path().join("data");
    std::fs::remove_file(env.dir.path().join("api.json")).unwrap();
    let store = Store::open(&data).unwrap();
    assert_eq!(store.prices().len(), 2);
    pika::reindex::reindex(&store).unwrap();
    assert_eq!(costs(&store)["session"], json!(4.5));
    // A restart applies the kept prices before fetching again.
    pricing::start(&store, Some(source)).unwrap();
    assert_eq!(store.prices().len(), 2);
    assert_eq!(costs(&store)["session"], json!(4.5));
    // Prices off: recorded costs only, in other processes too.
    pricing::start(&store, None).unwrap();
    assert!(store.prices().is_empty());
    assert_eq!(costs(&store)["session"], json!(1.5));
    assert!(!data.join("prices.json").exists());
    assert!(Store::open(&data).unwrap().prices().is_empty());
}

#[test]
fn only_magpie_zeros_wait_for_a_price() {
    let env = env();
    let mut plan = call("k3.1-pro", 1_000, 100, Some(0.0), "2026-11-01T09:00:03.000Z");
    plan["message"]["provider"] = json!("kimi-coding");
    let source = lines(&[
        json!({ "type": "session", "version": 3, "id": "0c5a7e00-pricing", "timestamp": "2026-11-01T09:00:00.000Z", "cwd": "/w" }),
        prompt("first", "2026-11-01T09:00:01.000Z"),
        // Magpie before it marked unknown prices: a plain zero.
        call("k3.1-pro", 1_000, 100, Some(0.0), "2026-11-01T09:00:02.000Z"),
        // A plan's zero is its price.
        plan,
    ]);
    upload(&env.store, KEY, "session", &source, 100);
    let events = json!([{ "seq": 2, "pricing": 2, "cost": 0.0 }, { "seq": 3, "pricing": 0, "cost": 0.0 }]);
    assert_eq!(costs(&env.store)["events"], events);
    // The upgrade marks existing calls by the same rule.
    let data = env.dir.path().join("data");
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V12} PRAGMA user_version = 11;")).unwrap();
    drop(conn);
    let store = Store::open(&data).unwrap();
    assert_eq!(costs(&store)["events"], events);
    store.set_prices(prices()).unwrap();
    assert_eq!(costs(&store)["events"], json!([{ "seq": 2, "pricing": 1, "cost": 0.003 }, { "seq": 3, "pricing": 0, "cost": 0.0 }]));
}
