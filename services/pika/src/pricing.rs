//! Estimated cost for model calls that recorded none, from a models.dev catalog. See `docs/SPEC.md`.
//!
//! A model call needs a price when Magpie Provider served it and it used tokens but recorded no cost (`usage.cost.total`
//! absent or zero): Magpie records zero rates for a model it has no price for (`magpiePricing: "unavailable"`, or no
//! mark before it estimated prices). Other providers' zeros are what Pi was told the call cost, such as a plan's, a free
//! tier's, or a local model's, and stay. pika never replaces a nonzero recorded cost. Derivation marks such calls
//! `UNPRICED` (`usage_events.pricing`), and [`reprice`] gives each one its model's price, `ESTIMATED`, or leaves it at
//! zero when no price is known.
//!
//! Catalog prices are read as Magpie Provider reads them (`extensions/magpie-provider/catalog-pricing.ts`): a catalog
//! model's name is its id's last `/` segment, every model with the same display name pools its published rates, and
//! the rates most of them publish win, paid rates over a plan's zeros. A tie, or no valid rates, leaves the name
//! unpriced. A call is looked up by the bare name pika stores, without an `@` parameter (`crate::util::bare_model`), so
//! `grok-4.7@500k` takes `grok-4.7`'s price where Magpie Provider would have none.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use rusqlite::{Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::Store;

pub const DEFAULT_SOURCE: &str = "https://models.dev/api.json";
/// `usage_events.pricing`: the cost as recorded with the usage.
pub const RECORDED: i64 = 0;
/// A call without a recorded cost, priced by pika.
pub const ESTIMATED: i64 = 1;
/// A call without a recorded cost or a known price; its cost stays zero.
pub const UNPRICED: i64 = 2;

const SNAPSHOT_FILE: &str = "prices.json";
const SNAPSHOT_VERSION: u32 = 1;
const REFRESH_AFTER_MS: i64 = 24 * 60 * 60 * 1000;
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CATALOG_BYTES: u64 = 64 << 20;
/// Pi's request-wide tiers before `tiers`: models.dev's `context_over_200k`.
const LEGACY_TIER_ABOVE: i64 = 200_000;

/// The provider whose zero costs mean an unknown price (`provider` in Magpie Provider's `extensions/magpie-provider`).
pub const PRICED_PROVIDER: &str = "magpie";

/// Whether a model call's usage needs a price: a Magpie call's tokens without a recorded cost. Schema version 12 marks
/// existing calls by the same rule.
pub fn needs_price(provider: Option<&str>, input: i64, output: i64, cache_read: i64, cache_write: i64, cost: f64) -> bool {
    provider == Some(PRICED_PROVIDER) && cost == 0.0 && input + output + cache_read + cache_write > 0
}

/// USD per million tokens.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl Rates {
    fn paid(&self) -> bool {
        self.input != 0.0 || self.output != 0.0 || self.cache_read != 0.0 || self.cache_write != 0.0
    }
}

/// Rates for a whole request whose prompt (input and cache tokens) exceeds `input_tokens_above`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier {
    pub input_tokens_above: i64,
    #[serde(flatten)]
    pub rates: Rates,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Price {
    #[serde(flatten)]
    pub rates: Rates,
    /// Ascending by threshold.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiers: Vec<Tier>,
}

impl Price {
    /// A call's cost in USD, as Pi's `calculateCost` reckons it: the highest tier whose threshold the prompt exceeds
    /// sets every rate.
    pub fn cost(&self, input: i64, output: i64, cache_read: i64, cache_write: i64) -> f64 {
        let prompt = input + cache_read + cache_write;
        let rates = self.tiers.iter().rev().find(|t| prompt > t.input_tokens_above).map_or(&self.rates, |t| &t.rates);
        (rates.input * input as f64
            + rates.output * output as f64
            + rates.cache_read * cache_read as f64
            + rates.cache_write * cache_write as f64)
            / 1_000_000.0
    }

    fn paid(&self) -> bool {
        self.rates.paid() || self.tiers.iter().any(|t| t.rates.paid())
    }
}

/// Model prices by name. Empty when prices are off or none have been loaded.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PriceTable {
    prices: HashMap<String, Price>,
}

impl PriceTable {
    pub fn new(prices: impl IntoIterator<Item = (String, Price)>) -> PriceTable {
        PriceTable { prices: prices.into_iter().collect() }
    }

    /// The price of a call's model, by the bare name pika stores (`crate::util::bare_model`).
    pub fn get(&self, model: &str) -> Option<&Price> {
        self.prices.get(model)
    }

    pub fn len(&self) -> usize {
        self.prices.len()
    }

    pub fn is_empty(&self) -> bool {
        self.prices.is_empty()
    }
}

/// A catalog model's name, as Magpie Provider reads it: the last `/` segment of an id without blanks, control
/// characters, or glob characters, whose segments are all nonempty.
fn model_name(id: &str) -> Option<&str> {
    if id.is_empty() || id.chars().any(|c| c.is_whitespace() || c.is_control() || "*?[]{}".contains(c)) {
        return None;
    }
    let mut segments = id.split('/');
    if segments.clone().any(str::is_empty) {
        return None;
    }
    segments.next_back()
}

fn rate(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|r| r.is_finite() && *r >= 0.0)
}

/// models.dev rates: input and output required, absent cache rates zero, any rate present valid.
fn rates(value: &Value) -> Option<Rates> {
    let optional = |key| match value.get(key) {
        None => Some(0.0),
        some => rate(some),
    };
    Some(Rates {
        input: rate(value.get("input"))?,
        output: rate(value.get("output"))?,
        cache_read: optional("cache_read")?,
        cache_write: optional("cache_write")?,
    })
}

/// A catalog row's `cost`, or `None` when it is missing or anything in it is invalid. Context tiers come from `tiers`,
/// else from `context_over_200k`; other tier kinds, and two tiers at one threshold, make the cost invalid.
fn catalog_price(value: Option<&Value>) -> Option<Price> {
    let value = value.filter(|v| v.is_object())?;
    let base = rates(value)?;
    let legacy = match value.get("context_over_200k") {
        None => None,
        Some(over) => Some(rates(over)?),
    };
    let mut tiers = match value.get("tiers") {
        Some(tiers) => tiers
            .as_array()?
            .iter()
            .map(|entry| {
                let tier = entry.get("tier")?;
                let size = tier.get("size")?;
                let size = size.as_i64().or_else(|| size.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15).map(|f| f as i64))?;
                (tier.get("type")?.as_str()? == "context" && size > 0)
                    .then_some(())
                    .and_then(|()| Some(Tier { input_tokens_above: size, rates: rates(entry)? }))
            })
            .collect::<Option<Vec<_>>>()?,
        None => legacy.map(|rates| Tier { input_tokens_above: LEGACY_TIER_ABOVE, rates }).into_iter().collect(),
    };
    tiers.sort_by_key(|t| t.input_tokens_above);
    if tiers.windows(2).any(|pair| pair[0].input_tokens_above == pair[1].input_tokens_above) {
        return None;
    }
    Some(Price { rates: base, tiers })
}

/// The rates most entries publish, paid rates winning over a plan's zeros; `None` on a tie, or for zeros alone when
/// any entry was invalid.
fn common_price(costs: &[&Option<Price>]) -> Option<Price> {
    let valid: Vec<&Price> = costs.iter().filter_map(|c| c.as_ref()).collect();
    let paid: Vec<&Price> = valid.iter().copied().filter(|p| p.paid()).collect();
    if paid.is_empty() && valid.len() != costs.len() {
        return None;
    }
    let mut votes: Vec<(&Price, usize)> = Vec::new();
    for price in if paid.is_empty() { valid } else { paid } {
        match votes.iter_mut().find(|(p, _)| *p == price) {
            Some((_, count)) => *count += 1,
            None => votes.push((price, 1)),
        }
    }
    votes.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    match votes.as_slice() {
        [(price, count), rest @ ..] if *count > rest.first().map_or(0, |(_, c)| *c) => Some((*price).clone()),
        _ => None,
    }
}

/// The prices in a models.dev catalog (`{ provider: { models: { id: { id, name, cost } } } }`). Malformed providers
/// and models are skipped; a catalog without any price is an error.
pub fn from_models_dev(catalog: &Value) -> Result<PriceTable> {
    let providers = catalog.as_object().context("the catalog is not a JSON object")?;
    let mut by_display: HashMap<&str, Vec<Option<Price>>> = HashMap::new();
    let mut displays: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for provider in providers.values() {
        let Some(models) = provider.get("models").and_then(Value::as_object) else { continue };
        for (id, row) in models {
            let Some(display) = row.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()) else { continue };
            if row.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                continue;
            }
            let Some(name) = model_name(id) else { continue };
            by_display.entry(display).or_default().push(catalog_price(row.get("cost")));
            displays.entry(name).or_default().insert(display);
        }
    }
    let prices: HashMap<String, Price> = displays
        .into_iter()
        .filter_map(|(name, displays)| {
            let costs: Vec<&Option<Price>> = displays.iter().flat_map(|d| &by_display[d]).collect();
            common_price(&costs).map(|price| (name.to_owned(), price))
        })
        .collect();
    if prices.is_empty() {
        bail!("the catalog lists no usable prices");
    }
    Ok(PriceTable { prices })
}

/// Gives every call that needs a price, in one session or in all, its model's price from `table` (or zero without
/// one), then recomputes the costs of the sessions and turns whose calls changed as derivation sums them: in entry
/// order. Returns the number of calls whose cost or pricing changed.
pub fn reprice(tx: &Transaction, table: &PriceTable, sid: Option<i64>) -> Result<usize> {
    let sql = "SELECT u.sid, u.seq, u.cost, u.pricing, m.model, u.input, u.output, u.cache_read, u.cache_write
         FROM usage_events u LEFT JOIN model_calls m ON m.sid = u.sid AND m.seq = u.seq
         WHERE u.pricing != 0";
    let mut statement = match sid {
        Some(_) => tx.prepare_cached(&format!("{sql} AND u.sid = ?1"))?,
        None => tx.prepare_cached(sql)?,
    };
    /// `sid`, `seq`, `cost`, `pricing`, the call's model, and its input, output, cache read, and cache write tokens.
    type Row = (i64, i64, f64, i64, Option<String>, [i64; 4]);
    let row = |r: &rusqlite::Row| -> rusqlite::Result<Row> {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, [r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?]))
    };
    let rows = match sid {
        Some(sid) => statement.query_map([sid], row)?.collect::<rusqlite::Result<Vec<_>>>()?,
        None => statement.query_map([], row)?.collect::<rusqlite::Result<Vec<_>>>()?,
    };
    let mut changed: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    for (sid, seq, cost, pricing, model, [input, output, cache_read, cache_write]) in rows {
        let (new_cost, new_pricing) = match model.as_deref().and_then(|m| table.get(m)) {
            Some(price) => (price.cost(input, output, cache_read, cache_write), ESTIMATED),
            None => (0.0, UNPRICED),
        };
        if new_cost == cost && new_pricing == pricing {
            continue;
        }
        tx.prepare_cached("UPDATE usage_events SET cost = ?3, pricing = ?4 WHERE sid = ?1 AND seq = ?2")?
            .execute(params![sid, seq, new_cost, new_pricing])?;
        tx.prepare_cached("UPDATE model_calls SET cost = ?3 WHERE sid = ?1 AND seq = ?2")?.execute(params![sid, seq, new_cost])?;
        changed.entry(sid).or_default().push(seq);
    }
    let calls = changed.values().map(Vec::len).sum();
    for (sid, seqs) in changed {
        let costs: Vec<(i64, f64)> = tx
            .prepare_cached("SELECT seq, cost FROM usage_events WHERE sid = ?1 ORDER BY seq")?
            .query_map([sid], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let sum = |from: i64, to: i64| costs.iter().filter(|(seq, _)| (from..=to).contains(seq)).fold(0.0, |sum, (_, c)| sum + c);
        tx.prepare_cached("UPDATE sessions SET cost = ?2 WHERE sid = ?1")?.execute(params![sid, sum(i64::MIN, i64::MAX)])?;
        let turns: Vec<(i64, i64, i64)> = tx
            .prepare_cached("SELECT idx, start_seq, end_seq FROM turns WHERE sid = ?1")?
            .query_map([sid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (idx, start, end) in turns.into_iter().filter(|(_, start, end)| seqs.iter().any(|s| (*start..=*end).contains(s))) {
            tx.prepare_cached("UPDATE turns SET cost = ?3 WHERE sid = ?1 AND idx = ?2")?.execute(params![sid, idx, sum(start, end)])?;
        }
    }
    Ok(calls)
}

/// The prices pika last fetched, kept in the data directory so a restart prices calls before fetching again.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    version: u32,
    source: String,
    fetched_at: i64,
    prices: BTreeMap<String, Price>,
}

fn snapshot_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SNAPSHOT_FILE)
}

/// The prices kept in the data directory, for every process that opens the store: a reindex by `pika reindex` or
/// after an upgrade prices calls as the running server does. None when prices are off, as `start` then removes them.
pub fn kept(data_dir: &Path) -> PriceTable {
    load_snapshot(data_dir).map(|s| PriceTable::new(s.prices)).unwrap_or_default()
}

fn load_snapshot(data_dir: &Path) -> Option<Snapshot> {
    let text = std::fs::read_to_string(snapshot_path(data_dir)).ok()?;
    serde_json::from_str::<Snapshot>(&text).ok().filter(|s| s.version == SNAPSHOT_VERSION && !s.prices.is_empty())
}

fn save_snapshot(data_dir: &Path, snapshot: &Snapshot) -> Result<()> {
    let path = snapshot_path(data_dir);
    let tmp = data_dir.join(format!(".{SNAPSHOT_FILE}.{}.tmp", hex::encode(crate::util::random_bytes::<6>())));
    std::fs::write(&tmp, serde_json::to_vec(snapshot)?).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// A catalog from an `http(s)` URL or a file.
fn read_catalog(source: &str) -> Result<Value> {
    let text = if source.starts_with("http://") || source.starts_with("https://") {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(FETCH_TIMEOUT))
            .user_agent(format!("pika/{}", env!("PIKA_BUILD")))
            .build()
            .into();
        agent.get(source).call()?.body_mut().with_config().limit(MAX_CATALOG_BYTES).read_to_string()?
    } else {
        std::fs::read_to_string(source).with_context(|| format!("reading {source}"))?
    };
    Ok(serde_json::from_str(&text)?)
}

/// Fetches the catalog, keeps its prices in the data directory, and prices the store's calls with them.
pub fn refresh(store: &Store, source: &str) -> Result<usize> {
    let table = from_models_dev(&read_catalog(source)?)?;
    let snapshot = Snapshot {
        version: SNAPSHOT_VERSION,
        source: source.to_owned(),
        fetched_at: crate::util::now_ms(),
        prices: table.prices.iter().map(|(name, price)| (name.clone(), price.clone())).collect(),
    };
    if let Err(e) = save_snapshot(store.data_dir(), &snapshot) {
        tracing::warn!("prices: keeping the catalog for a restart failed: {e:#}");
    }
    let count = table.len();
    store.set_prices(table)?;
    Ok(count)
}

/// Starts pricing for `serve`: the kept prices at once, then a thread that fetches `source` when they are missing, a
/// day old (or from the future), or from another source, and every day after. `None` turns prices off and removes the
/// kept prices, so only recorded costs count, in other processes too.
pub fn start(store: &Arc<Store>, source: Option<&str>) -> Result<Option<JoinHandle<()>>> {
    let Some(source) = source else {
        match std::fs::remove_file(snapshot_path(store.data_dir())) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(e).context("removing the kept prices");
            }
            _ => {}
        }
        store.set_prices(PriceTable::default())?;
        return Ok(None);
    };
    let kept = load_snapshot(store.data_dir());
    let mut fetched_at = kept.as_ref().filter(|s| s.source == source).map_or(i64::MIN, |s| s.fetched_at);
    if let Some(kept) = kept {
        store.set_prices(PriceTable::new(kept.prices))?;
    }
    let store = store.clone();
    let source = source.to_owned();
    let thread = std::thread::Builder::new().name("pika-prices".into()).spawn(move || {
        loop {
            let age = crate::util::now_ms().saturating_sub(fetched_at);
            if !(0..REFRESH_AFTER_MS).contains(&age) {
                match refresh(&store, &source) {
                    Ok(count) => {
                        fetched_at = crate::util::now_ms();
                        tracing::info!("prices: {count} model prices from {source}");
                    }
                    Err(e) => tracing::warn!("prices: fetching {source} failed, retrying within an hour: {e:#}"),
                }
            }
            std::thread::sleep(CHECK_EVERY);
        }
    });
    Ok(Some(thread.context("starting the price refresh")?))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn rates(input: f64, output: f64, cache_read: f64, cache_write: f64) -> Rates {
        Rates { input, output, cache_read, cache_write }
    }

    #[test]
    fn names_follow_magpie_provider() {
        assert_eq!(model_name("moonshotai/kimi-k3.1-pro"), Some("kimi-k3.1-pro"));
        assert_eq!(model_name("auto/openai/gpt-6.1-terra"), Some("gpt-6.1-terra"));
        assert_eq!(model_name("kimi-k3@eu"), Some("kimi-k3@eu"));
        assert_eq!(model_name("a//b"), None);
        assert_eq!(model_name("gpt-*"), None);
        assert_eq!(model_name("gpt 6"), None);
        assert_eq!(model_name(""), None);
    }

    #[test]
    fn reads_catalog_costs() {
        let tiered = json!({ "input": 1, "output": 5, "cache_read": 0.05, "cache_write": 1.25,
            "tiers": [{ "input": 2, "output": 7.5, "cache_read": 0.1, "cache_write": 2.5, "tier": { "type": "context", "size": 272000 } }],
            "context_over_200k": { "input": 2, "output": 7.5 } });
        let price = catalog_price(Some(&tiered)).unwrap();
        assert_eq!(price.rates, rates(1.0, 5.0, 0.05, 1.25));
        assert_eq!(price.tiers, vec![Tier { input_tokens_above: 272_000, rates: rates(2.0, 7.5, 0.1, 2.5) }]);
        // Without `tiers`, `context_over_200k` is a tier at 200k; absent cache rates are zero.
        let legacy = catalog_price(Some(&json!({ "input": 3, "output": 15, "context_over_200k": { "input": 6, "output": 22.5 } }))).unwrap();
        assert_eq!(legacy.rates, rates(3.0, 15.0, 0.0, 0.0));
        assert_eq!(legacy.tiers, vec![Tier { input_tokens_above: 200_000, rates: rates(6.0, 22.5, 0.0, 0.0) }]);
        for invalid in [
            json!({ "input": 1 }),
            json!({ "input": -1, "output": 1 }),
            json!({ "input": 1, "output": 1, "cache_read": null }),
            json!({ "input": 1, "output": 1, "tiers": [{ "input": 1, "output": 1, "tier": { "type": "time", "size": 5 } }] }),
            json!({ "input": 1, "output": 1, "tiers": [
                { "input": 1, "output": 1, "tier": { "type": "context", "size": 5 } },
                { "input": 2, "output": 2, "tier": { "type": "context", "size": 5 } }] }),
            json!({ "input": 1, "output": 1, "context_over_200k": { "input": 2 } }),
        ] {
            assert_eq!(catalog_price(Some(&invalid)), None, "{invalid}");
        }
        assert_eq!(catalog_price(None), None);
    }

    #[test]
    fn the_most_published_paid_rates_win() {
        let price = |input: f64| Some(Price { rates: rates(input, input * 5.0, 0.0, 0.0), tiers: Vec::new() });
        let zero = Some(Price::default());
        assert_eq!(common_price(&[&price(2.0), &price(2.0), &price(3.0), &zero, &zero, &zero]), price(2.0));
        // A tie, and zeros beside an invalid entry, are unpriced; zeros alone price a free model.
        assert_eq!(common_price(&[&price(2.0), &price(3.0)]), None);
        assert_eq!(common_price(&[&zero, &None]), None);
        assert_eq!(common_price(&[&zero, &zero]), zero);
        assert_eq!(common_price(&[&price(2.0), &None]), price(2.0));
    }

    #[test]
    fn tiers_price_the_whole_request() {
        let price = Price {
            rates: rates(1.0, 5.0, 0.05, 1.25),
            tiers: vec![
                Tier { input_tokens_above: 200_000, rates: rates(2.0, 7.5, 0.1, 2.5) },
                Tier { input_tokens_above: 400_000, rates: rates(4.0, 10.0, 0.2, 5.0) },
            ],
        };
        let close = |a: f64, b: f64| assert!((a - b).abs() < 1e-12, "{a} != {b}");
        // The prompt counts cache tokens; the highest tier it exceeds prices output too.
        close(price.cost(1_000_000, 0, 0, 0), 4.0);
        close(price.cost(150_000, 1_000_000, 100_000, 0), 0.3 + 7.5 + 0.01);
        // A prompt at a threshold does not exceed it.
        close(price.cost(100_000, 1_000_000, 100_000, 0), 0.1 + 5.0 + 0.005);
        let magpie = Some(PRICED_PROVIDER);
        assert!(needs_price(magpie, 10, 0, 0, 0, 0.0));
        assert!(!needs_price(magpie, 10, 0, 0, 0, 0.01));
        assert!(!needs_price(magpie, 0, 0, 0, 0, 0.0));
        // Other providers' zeros are their price: a plan, a free tier, a local model.
        assert!(!needs_price(Some("kimi-coding"), 10, 0, 0, 0, 0.0));
        assert!(!needs_price(None, 10, 0, 0, 0, 0.0));
    }

    #[test]
    fn pools_prices_by_display_name() {
        let model = |id: &str, name: &str, cost: Value| json!({ "id": id, "name": name, "cost": cost });
        let catalog = json!({
            "moonshotai": { "models": { "kimi-k3.1-pro": model("kimi-k3.1-pro", "Kimi K3.1 Pro", json!({ "input": 2, "output": 10 })) } },
            "openrouter": { "models": { "moonshotai/kimi-k3.1-pro": model("moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro", json!({ "input": 2, "output": 10 })) } },
            // A plan lists the model under the bare id the gateway uses, at zero.
            "kimi-code-plan": { "models": {
                "k3.1-pro": model("k3.1-pro", "Kimi K3.1 Pro", json!({ "input": 0, "output": 0 })),
                "mismatched": model("other", "Other", json!({ "input": 1, "output": 1 })),
            } },
            "broken": { "models": [] },
        });
        let table = from_models_dev(&catalog).unwrap();
        assert_eq!(table.len(), 2);
        assert_eq!(table.get("k3.1-pro").unwrap().rates, rates(2.0, 10.0, 0.0, 0.0));
        assert_eq!(table.get("kimi-k3.1-pro"), table.get("k3.1-pro"));
        assert!(table.get("other").is_none());
        assert!(from_models_dev(&json!({})).is_err());
    }
}
