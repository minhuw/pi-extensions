//! The dataset: a deterministic plan of sessions (sizes, hierarchy, devices, projects, times) and the generation of
//! each family (a root session with every descendant, and for Herder orchestrators the run's journal and documents)
//! as pi session JSONL, Herder journal lines, and captured model requests.

use std::collections::{HashMap, HashSet};

use pika::util::{format_iso_ms, sha256_hex};
use serde_json::{Map, Value, json};

use crate::rng::{Alias, Rng};
use crate::text::Vocab;

pub const SEED: u64 = 0x7069_6b61_7065_7266;
pub const DAY_MS: i64 = 86_400_000;
/// 2025-10-26T00:00:00Z: the dataset covers the year from here.
pub const START_MS: i64 = 1_761_436_800_000;

pub const DEVICES: &[&str] = &["laptop", "desktop", "workstation", "homelab", "travel"];
const HOMES: &[&str] = &["/Users/minh/code", "/home/minh/src", "/home/minh/work", "/srv/minh", "/Users/minh/dev"];
pub const PROJECTS: usize = 40;

pub struct Model {
    pub id: &'static str,
    pub provider: &'static str,
    pub api: &'static str,
    /// USD per million input, output, cache-read, and cache-write tokens.
    price: [f64; 4],
}

pub const MODELS: &[Model] = &[
    Model { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages", price: [3.0, 15.0, 0.3, 3.75] },
    Model { id: "claude-opus-4-1", provider: "anthropic", api: "anthropic-messages", price: [15.0, 75.0, 1.5, 18.75] },
    Model { id: "claude-haiku-4-5", provider: "anthropic", api: "anthropic-messages", price: [1.0, 5.0, 0.1, 1.25] },
    Model { id: "gpt-5", provider: "openai", api: "openai-responses", price: [1.25, 10.0, 0.125, 0.0] },
    Model { id: "gpt-5-mini", provider: "openai", api: "openai-responses", price: [0.25, 2.0, 0.025, 0.0] },
    Model { id: "gemini-2.5-pro", provider: "google", api: "google-generative-ai", price: [1.25, 10.0, 0.31, 0.0] },
];
const ROOT_MODEL_WEIGHTS: &[f64] = &[35.0, 10.0, 12.0, 23.0, 10.0, 10.0];
const CHILD_MODEL_WEIGHTS: &[f64] = &[30.0, 3.0, 40.0, 10.0, 12.0, 5.0];
const AGENT_TYPES: &[&str] = &["recon", "worker", "reviewer", "expert"];
pub const TOOLS: &[&str] = &["bash", "read", "edit", "write", "codemode", "web_search", "Agent"];
/// Tool mix for calls that do not start a subagent: bash, read, edit, write, codemode, web_search.
const TOOL_WEIGHTS: &[f64] = &[35.0, 30.0, 16.0, 6.0, 7.0, 6.0];
pub const BIG_SIZE: usize = 5_000;
pub const HUGE_SIZE: usize = 20_000;
pub const BIG_SESSIONS: usize = 5;
pub const HUGE_SESSIONS: usize = 2;
const MIN_SIZE: usize = 6;
const MAX_SIZE: usize = 4_000;

#[derive(Clone, Debug)]
pub struct Config {
    pub sessions: usize,
    pub entries: u64,
    pub herder_runs: usize,
    pub request_sessions: usize,
    pub days: i64,
}

impl Config {
    pub fn full() -> Config {
        Config { sessions: 10_000, entries: 2_560_000, herder_runs: 20, request_sessions: 50, days: 365 }
    }

    /// A smaller dataset of the same shape, for trying the scripts; the 5,000 and 20,000-entry sessions stay.
    pub fn scaled(scale: f64) -> Config {
        let full = Config::full();
        let n = |x: usize| ((x as f64 * scale).round() as usize).max(1);
        Config {
            sessions: n(full.sessions).max(200),
            entries: ((full.entries as f64 * scale) as u64).max(100_000),
            herder_runs: n(full.herder_runs),
            request_sessions: n(full.request_sessions),
            days: full.days,
        }
    }
}

#[derive(Clone, Debug)]
pub enum Role {
    Root,
    Subagent { header_only: bool, workflow: Option<String>, agent_type: &'static str },
    Orchestrator { run: usize },
    Step { run: usize, attempt: usize },
}

#[derive(Clone, Debug)]
pub struct SessionPlan {
    pub size: usize,
    pub parent: Option<usize>,
    pub role: Role,
    pub children: Vec<usize>,
    pub requests: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Outcome {
    Ok,
    Retry,
    Stopped,
}

#[derive(Clone, Debug)]
pub struct StepAttempt {
    pub key: String,
    pub task: String,
    pub role: &'static str,
    pub attempt: i64,
    pub launch: i64,
    pub session: usize,
    pub outcome: Outcome,
}

#[derive(Clone, Debug)]
pub struct RunPlan {
    pub orchestrator: usize,
    pub steps: Vec<StepAttempt>,
    /// The attempt index where a second launch resumes the run.
    pub resume_at: Option<usize>,
    pub finished: bool,
}

#[derive(Clone, Debug)]
pub struct Family {
    pub root: usize,
    pub start_ms: i64,
    pub device: usize,
    pub project: usize,
}

pub struct Plan {
    pub config: Config,
    pub sessions: Vec<SessionPlan>,
    pub families: Vec<Family>,
    pub runs: Vec<RunPlan>,
    pub projects: Vec<String>,
}

fn weighted_pick(rng: &mut Rng, cumulative: &[f64]) -> usize {
    let total = *cumulative.last().unwrap();
    let x = rng.f64() * total;
    cumulative.partition_point(|&c| c <= x).min(cumulative.len() - 1)
}

/// Room for subagent calls in a session of `size` entries.
fn child_capacity(size: usize) -> usize {
    size.saturating_sub(8) / 6
}

impl Plan {
    pub fn new(config: Config, vocab: &Vocab) -> Plan {
        let mut rng = Rng::fork(SEED, 0);
        let n = config.sessions;

        let mut projects = Vec::new();
        let mut seen = HashSet::new();
        while projects.len() < PROJECTS {
            let name = match rng.below(3) {
                0 => vocab.words[200 + rng.below(3000)].clone(),
                1 => format!("{}-{}", vocab.words[100 + rng.below(2000)], vocab.words[100 + rng.below(2000)]),
                _ => format!("pi-{}", vocab.words[300 + rng.below(4000)]),
            };
            if seen.insert(name.clone()) {
                projects.push(name);
            }
        }

        // Herder runs: impl and review steps per task, some retried, some resumed in a second launch.
        let mut runs: Vec<RunPlan> = Vec::new();
        let mut step_attempts = 0;
        for _ in 0..config.herder_runs {
            let tasks = 2 + rng.below(3);
            let resumed = rng.chance(0.3);
            let mut steps = Vec::new();
            for task in 1..=tasks {
                for (prefix, role) in [("impl", "worker"), ("review", "reviewer")] {
                    let key = format!("{prefix}-T{task}");
                    let retries = if rng.chance(0.2) { 1 } else { 0 };
                    for attempt in 0..=retries {
                        let outcome = if attempt < retries { Outcome::Retry } else { Outcome::Ok };
                        steps.push(StepAttempt {
                            key: key.clone(),
                            task: format!("T{task}"),
                            role,
                            attempt: attempt as i64 + 1,
                            launch: 1,
                            session: 0,
                            outcome,
                        });
                    }
                }
            }
            let finished = rng.chance(0.85);
            if !finished && let Some(last) = steps.last_mut() {
                last.outcome = Outcome::Stopped;
            }
            let resume_at = resumed.then(|| 1 + rng.below(steps.len().max(2) - 1));
            if let Some(at) = resume_at {
                // The interrupted attempt is retried as attempt 1 of launch 2; later steps belong to launch 2 too.
                let mut retried = steps[at - 1].clone();
                steps[at - 1].outcome = Outcome::Retry;
                retried.attempt = 1;
                steps.insert(at, retried);
                for step in &mut steps[at..] {
                    step.launch = 2;
                }
            }
            step_attempts += steps.len();
            runs.push(RunPlan { orchestrator: 0, steps, resume_at, finished });
        }

        let children_total = (n as f64 * 0.30).round() as usize;
        let subagents = children_total.saturating_sub(step_attempts);
        let roots = n - subagents - step_attempts;
        let specials = BIG_SESSIONS + HUGE_SESSIONS;
        assert!(roots > specials + runs.len(), "too few sessions for the plan");

        // Sizes: long-tailed, then scaled so the total meets the target; the special sizes stay exact.
        let mut sizes: Vec<usize> = (0..n).map(|_| rng.lognormal(95.0, 1.25).round() as usize).collect();
        for (i, size) in sizes.iter_mut().enumerate().take(specials) {
            *size = if i < BIG_SESSIONS { BIG_SIZE } else { HUGE_SIZE };
        }
        let special_total = (BIG_SESSIONS * BIG_SIZE + HUGE_SESSIONS * HUGE_SIZE) as f64;
        let mut factor = 1.0;
        for _ in 0..6 {
            let sum: f64 = sizes[specials..]
                .iter()
                .map(|&s| ((s as f64 * factor).round() as usize).clamp(MIN_SIZE, MAX_SIZE) as f64)
                .sum();
            factor *= (config.entries as f64 - special_total) / sum;
        }
        for size in &mut sizes[specials..] {
            *size = ((*size as f64 * factor).round() as usize).clamp(MIN_SIZE, MAX_SIZE);
        }
        let mut total: u64 = sizes.iter().map(|&s| s as u64).sum();
        while total < config.entries {
            let i = specials + rng.below(n - specials);
            let add = (config.entries - total).min(1 + rng.below(40) as u64) as usize;
            if sizes[i] + add <= MAX_SIZE {
                sizes[i] += add;
                total += add as u64;
            }
        }

        // Roots first (specials, then orchestrators), then subagents, then step sessions.
        let mut sessions: Vec<SessionPlan> = sizes
            .iter()
            .map(|&size| SessionPlan { size, parent: None, role: Role::Root, children: Vec::new(), requests: false })
            .collect();
        for (r, run) in runs.iter_mut().enumerate() {
            let orchestrator = specials + r;
            run.orchestrator = orchestrator;
            sessions[orchestrator].role = Role::Orchestrator { run: r };
            sessions[orchestrator].size = sessions[orchestrator].size.max(60);
        }
        let mut next = roots + subagents;
        for (r, run) in runs.iter_mut().enumerate() {
            for (a, step) in run.steps.iter_mut().enumerate() {
                step.session = next;
                sessions[next].role = Role::Step { run: r, attempt: a };
                sessions[next].parent = Some(run.orchestrator);
                sessions[run.orchestrator].children.push(next);
                next += 1;
            }
        }

        // Subagents attach to roots, or for nested ones to earlier subagents, weighted by size.
        let root_weights: Vec<f64> = (0..roots)
            .scan(0.0, |acc, i| {
                *acc += if matches!(sessions[i].role, Role::Root) { sessions[i].size as f64 } else { 0.0 };
                Some(*acc)
            })
            .collect();
        let mut level1: Vec<usize> = Vec::new();
        let mut level1_weights: Vec<f64> = Vec::new();
        for child in roots..roots + subagents {
            let nested = !level1.is_empty() && rng.chance(0.15);
            let mut parent = None;
            for _ in 0..50 {
                let candidate =
                    if nested { level1[weighted_pick(&mut rng, &level1_weights)] } else { weighted_pick(&mut rng, &root_weights) };
                if sessions[candidate].children.len() < child_capacity(sessions[candidate].size) {
                    parent = Some(candidate);
                    break;
                }
            }
            let parent = parent
                .or_else(|| (0..roots).find(|&i| sessions[i].children.len() < child_capacity(sessions[i].size)))
                .expect("room for every subagent");
            let nested = !matches!(sessions[parent].role, Role::Root);
            sessions[parent].children.push(child);
            sessions[child].parent = Some(parent);
            let workflow = rng.chance(0.15).then(|| format!("wf-{}", rng.hex(8)));
            sessions[child].role = Role::Subagent { header_only: rng.chance(0.12), workflow, agent_type: rng.pick(AGENT_TYPES) };
            if !nested {
                level1.push(child);
                level1_weights.push(level1_weights.last().copied().unwrap_or(0.0) + sessions[child].size as f64);
            }
        }

        // Captured requests for ordinary mid-sized root sessions.
        let mut candidates: Vec<usize> = (specials..roots)
            .filter(|&i| matches!(sessions[i].role, Role::Root) && (80..=600).contains(&sessions[i].size))
            .collect();
        for k in 0..config.request_sessions.min(candidates.len()) {
            let j = k + rng.below(candidates.len() - k);
            candidates.swap(k, j);
            sessions[candidates[k]].requests = true;
        }

        // Families start through the year, more on weekdays and in the afternoon. The specials spread out.
        let project_zipf = Alias::zipf(PROJECTS, 0.9);
        let mut families: Vec<Family> = (0..roots)
            .map(|root| {
                let day = if root < specials {
                    (config.days * (root as i64 * 2 + 1)) / (specials as i64 * 2)
                } else {
                    loop {
                        let day = rng.range(0, config.days - 1);
                        if (day + 6) % 7 < 5 || rng.chance(0.4) {
                            break day;
                        }
                    }
                };
                let hour = (14.0 + 3.5 * rng.normal()).clamp(0.0, 23.9);
                let start_ms = START_MS + day * DAY_MS + (hour * 3_600_000.0) as i64 + rng.range(0, 59_999);
                let project = project_zipf.sample(&mut rng);
                let device = match rng.f64() {
                    x if x < 0.75 => project % DEVICES.len(),
                    x if x < 0.95 => (project * 3 + 1) % DEVICES.len(),
                    _ => rng.below(DEVICES.len()),
                };
                Family { root, start_ms, device, project }
            })
            .collect();
        families.sort_by_key(|f| (f.start_ms, f.root));

        Plan { config, sessions, families, runs, projects }
    }

    /// The sessions of a family, parents before their children.
    pub fn family_sessions(&self, root: usize) -> Vec<usize> {
        let mut out = vec![root];
        let mut i = 0;
        while i < out.len() {
            out.extend(self.sessions[out[i]].children.iter().copied());
            i += 1;
        }
        out
    }
}

pub struct RequestOut {
    pub id: String,
    pub seq: i64,
    pub at: String,
    pub fidelity: &'static str,
    pub model: usize,
    pub assistant_ts: i64,
    pub response_id: String,
    /// The request's `timing`, consistent with its model call.
    pub timing: Value,
    pub skeleton: Value,
    /// Every block the skeleton references, in order of first appearance.
    pub hashes: Vec<String>,
    /// The blocks this session has not sent before.
    pub blocks: Vec<(String, String)>,
}

pub struct StreamOut {
    pub key: String,
    pub kind: &'static str,
    pub path: String,
    pub lines: Vec<String>,
    pub requests: Vec<RequestOut>,
}

pub struct DocumentOut {
    pub key: String,
    pub kind: &'static str,
    pub run_id: String,
    pub content: String,
}

pub struct FamilyOut {
    pub device: usize,
    pub streams: Vec<StreamOut>,
    pub documents: Vec<DocumentOut>,
}

/// How a child session was started: its id, file, and the parent's call.
#[derive(Clone)]
struct Spawn {
    parent_id: String,
    parent_file: String,
    call_id: Option<String>,
    parent_agent: Option<String>,
    start_ms: i64,
}

fn session_file(dir: &str, at: i64, id: &str) -> String {
    let stamp = format_iso_ms(at).replace([':', '.'], "-");
    format!("{dir}/{stamp}_{id}.jsonl")
}

fn sessions_dir(cwd: &str) -> String {
    format!("/Users/minh/.pi/agent/sessions/--{}--", cwd.trim_start_matches('/').replace(['/', ':'], "-"))
}

fn system_prompt(vocab: &Vocab, rng: &mut Rng, cwd: &str) -> String {
    format!(
        "You are an expert coding assistant operating inside pi, a coding agent harness.\n\n<tools>\n{}\n</tools>\n\n<rules>\n{}\n</rules>\n\nCurrent working directory: {cwd}",
        TOOLS.iter().map(|t| format!("- {t}: {}", vocab.phrase(rng, 8))).collect::<Vec<_>>().join("\n"),
        vocab.prose(rng, 6_000)
    )
}

fn tool_defs(vocab: &Vocab, rng: &mut Rng) -> Vec<Value> {
    TOOLS
        .iter()
        .map(|name| {
            json!({ "name": name, "description": vocab.prose(rng, 300),
                    "input_schema": { "type": "object", "properties": { "command": { "type": "string", "description": vocab.phrase(rng, 6) } } } })
        })
        .collect()
}

/// A captured call's `timing` and its message's `durationMs`, from a generator seeded by its response id, so that every
/// other generated value stays as it was: sent a few ms after `ts`, response headers 150 to 900 ms later (missing for
/// about 1 in 10), the first token 0.3 to 8 s after sending (longer with thinking), and the end after streaming the rest.
fn call_timing(content: &[Value], bytes: usize, ts: i64, response_id: &str) -> (Value, i64) {
    let seed = u64::from_str_radix(&response_id[5..21], 16).expect("hex response id");
    let mut rng = Rng::fork(seed, 0x7151);
    let has = |ty: &str| content.iter().any(|b| b["type"] == ty);
    let first_token = if has("thinking") {
        "thinking"
    } else if has("text") {
        "text"
    } else {
        "toolCall"
    };
    let sent = ts + rng.range(2, 50);
    let response = sent + rng.range(150, 900);
    let median = if first_token == "thinking" { 2_500.0 } else { 900.0 };
    let ttft = (rng.lognormal(median, 0.6) as i64).clamp(300, 8_000);
    let first = (sent + ttft).max(response + rng.range(5, 120));
    // About 60 tokens a second of 4 bytes each, plus the end of the stream.
    let end = first + bytes as i64 / 4 * 1_000 / 60 + rng.range(50, 600);
    let mut timing = json!({ "sentAt": sent, "responseAt": response, "firstTokenAt": first, "firstToken": first_token });
    if rng.chance(0.1) {
        timing.as_object_mut().expect("an object").remove("responseAt");
    }
    (timing, end - ts)
}

/// Request capture for one session: the model context so far and the system prompt and tools of the payload.
struct Capture {
    system: String,
    tools: Vec<Value>,
    context: Vec<Value>,
    seq: i64,
    sent: HashSet<String>,
    out: Vec<RequestOut>,
}

struct SessionGen<'a> {
    vocab: &'a Vocab,
    rng: &'a mut Rng,
    size: usize,
    project: String,
    lines: Vec<String>,
    prev: Option<String>,
    t: i64,
    model: usize,
    switch_at: Option<(usize, usize)>,
    context_tokens: i64,
    since_compaction: usize,
    compaction_every: usize,
    name_at_turn: Option<usize>,
    turns: usize,
    /// Children still to start: (planned seq, child index), in order.
    pending: Vec<(usize, usize)>,
    spawned: Vec<(usize, String, i64)>,
    capture: Option<Capture>,
    /// A displayed notice steered into the next turn's run after its first tool results, as Subagents delivers a
    /// background child's completion.
    notice: Option<String>,
}

impl SessionGen<'_> {
    fn full(&self) -> bool {
        self.lines.len() >= self.size
    }

    fn remaining(&self) -> usize {
        self.size - self.lines.len()
    }

    /// Whether the next model call starts a child: at its planned point, or when the session nears its end.
    fn child_due(&self) -> bool {
        self.pending.first().is_some_and(|&(at, _)| self.lines.len() >= at || self.remaining() <= 4 * self.pending.len() + 12)
    }

    fn entry(&mut self, ty: &str, fields: Value) {
        if self.full() {
            return;
        }
        let id = self.rng.hex(8);
        let mut obj = Map::new();
        obj.insert("type".into(), json!(ty));
        obj.insert("id".into(), json!(id));
        obj.insert("parentId".into(), json!(self.prev));
        obj.insert("timestamp".into(), json!(format_iso_ms(self.t)));
        if let Value::Object(fields) = fields {
            obj.extend(fields);
        }
        self.lines.push(Value::Object(obj).to_string());
        self.prev = Some(id);
        self.since_compaction += 1;
    }

    fn message(&mut self, message: Value) {
        let bytes = message.to_string().len();
        self.message_counted(message, bytes);
    }

    /// `message`, counting `bytes` toward the context.
    fn message_counted(&mut self, message: Value, bytes: usize) {
        if self.full() {
            return;
        }
        self.context_tokens += bytes as i64 / 4;
        if let Some(capture) = &mut self.capture {
            capture.context.push(message.clone());
        }
        self.entry("message", json!({ "message": message }));
    }

    fn advance(&mut self, median_ms: f64, sigma: f64) {
        self.t += self.rng.lognormal(median_ms, sigma).max(5.0) as i64;
    }

    fn usage(&mut self, output_bytes: usize) -> Value {
        let model = &MODELS[self.model];
        let input = 2_500 + self.context_tokens;
        let output = (output_bytes / 4) as i64 + 20;
        let cache_read = input * 85 / 100;
        let cache_write = input - cache_read;
        let fresh = input - cache_read - cache_write;
        let price = |tokens: i64, i: usize| tokens as f64 * model.price[i] / 1e6;
        let (ci, co, cr, cw) = (price(fresh, 0), price(output, 1), price(cache_read, 2), price(cache_write, 3));
        json!({ "input": fresh, "output": output, "cacheRead": cache_read, "cacheWrite": cache_write,
                "totalTokens": input + output,
                "cost": { "input": ci, "output": co, "cacheRead": cr, "cacheWrite": cw, "total": ci + co + cr + cw } })
    }

    /// Captures the request for the assistant message about to be written at `ts`.
    fn capture_request(&mut self, ts: i64, response_id: &str, timing: Value) {
        let Some(capture) = &mut self.capture else { return };
        capture.seq += 1;
        let fidelity = if capture.seq % 5 == 0 { "context" } else { "payload" };
        let payload = if fidelity == "payload" {
            json!({ "model": MODELS[self.model].id, "max_tokens": 32_000, "stream": true,
                    "system": [{ "type": "text", "text": capture.system }],
                    "tools": capture.tools, "messages": capture.context })
        } else {
            let mut messages = vec![json!({ "role": "system", "content": capture.system, "timestamp": ts - 10 })];
            messages.extend(capture.context.iter().cloned());
            json!({ "messages": messages })
        };
        let (skeleton, blocks) = pika::requests::split(&payload);
        let hashes = blocks.iter().map(|(h, _)| h.clone()).collect();
        let new_blocks = blocks.into_iter().filter(|(h, _)| capture.sent.insert(h.clone())).collect();
        capture.out.push(RequestOut {
            id: self.rng.uuid(),
            seq: capture.seq,
            at: format_iso_ms(ts - 1_000 - self.rng.range(0, 2_000)),
            fidelity,
            model: self.model,
            assistant_ts: ts,
            response_id: response_id.to_owned(),
            timing,
            skeleton,
            hashes,
            blocks: new_blocks,
        });
    }

    fn assistant(&mut self, content: Vec<Value>, stop: &str) {
        if self.full() {
            return;
        }
        self.advance(6_000.0, 0.9);
        if let Some((at, model)) = self.switch_at
            && self.lines.len() >= at
        {
            self.switch_at = None;
            self.model = model;
            let m = &MODELS[model];
            self.entry("model_change", json!({ "provider": m.provider, "modelId": m.id }));
            self.advance(2_000.0, 0.5);
            if self.full() {
                return;
            }
        }
        let bytes: usize = content.iter().map(|b| b.to_string().len()).sum();
        let usage = self.usage(bytes);
        let response_id = format!("resp_{}", self.rng.hex(24));
        let ts = self.t;
        let timed = self.capture.is_some().then(|| call_timing(&content, bytes, ts, &response_id));
        let duration_ms = timed.as_ref().map(|(_, duration_ms)| *duration_ms);
        if let Some((timing, _)) = timed {
            self.capture_request(ts, &response_id, timing);
        }
        let m = &MODELS[self.model];
        let mut message = json!({ "role": "assistant", "content": content, "api": m.api, "provider": m.provider, "model": m.id,
                                  "usage": usage, "stopReason": stop, "timestamp": ts, "responseId": response_id });
        // Counted without `durationMs`, which only sessions with captured requests have, so usage stays as it was.
        let counted = message.to_string().len();
        if let Some(duration_ms) = duration_ms {
            message["durationMs"] = json!(duration_ms);
        }
        self.message_counted(message, counted);
    }

    fn thinking(&mut self) -> Option<Value> {
        self.rng.chance(0.6).then(|| {
            let bytes = self.rng.lognormal(280.0, 0.8) as usize;
            json!({ "type": "thinking", "thinking": self.vocab.prose(self.rng, bytes), "thinkingSignature": self.rng.hex(32) })
        })
    }

    fn result_size(&mut self, median: f64, sigma: f64) -> usize {
        if self.rng.chance(0.001) {
            self.rng.lognormal(50_000.0, 0.15) as usize
        } else {
            (self.rng.lognormal(median, sigma) as usize).clamp(20, 200_000)
        }
    }

    /// A tool call and its result text.
    fn tool(&mut self) -> (Value, Value, String) {
        let v = self.vocab;
        let kind = match self.rng.f64() * TOOL_WEIGHTS.iter().sum::<f64>() {
            x if x < 35.0 => 0,
            x if x < 65.0 => 1,
            x if x < 81.0 => 2,
            x if x < 87.0 => 3,
            x if x < 94.0 => 4,
            _ => 5,
        };
        let name = TOOLS[kind];
        let (args, result) = match name {
            "bash" => {
                let command = match self.rng.below(5) {
                    0 => format!("cargo test -p {} {}", self.project, v.ident(self.rng)),
                    1 => format!("npm run {} -- {}", v.word(self.rng), v.path(self.rng)),
                    2 => format!("rg -n \"{}\" {}", v.ident(self.rng), v.path(self.rng)),
                    3 => format!("git diff --stat {}", self.rng.hex(7)),
                    _ => format!("ls -la {}", v.path(self.rng)),
                };
                let size = self.result_size(1_000.0, 0.8);
                (json!({ "command": command }), v.log(self.rng, size, &self.project))
            }
            "read" => {
                let size = self.result_size(1_600.0, 0.6);
                (json!({ "path": v.path(self.rng) }), v.code(self.rng, size))
            }
            "edit" => {
                let path = v.path(self.rng);
                let (old, new) = (v.code_plus(self.rng, 60, 300), v.code_plus(self.rng, 60, 350));
                (json!({ "path": path, "edits": [{ "oldText": old, "newText": new }] }), format!("Successfully replaced 1 block(s) in {path}."))
            }
            "write" => {
                let path = v.path(self.rng);
                let content = v.code_plus(self.rng, 200, 1_800);
                let result = format!("Successfully wrote {} bytes to {path}", content.len());
                (json!({ "path": path, "content": content }), result)
            }
            "codemode" => {
                let code = v.code_plus(self.rng, 150, 600);
                let size = self.result_size(700.0, 1.0);
                (json!({ "code": code }), v.log(self.rng, size, &self.project))
            }
            _ => {
                let query = v.phrase_plus(self.rng, 3, 4);
                let size = self.result_size(1_500.0, 0.5);
                let mut text = String::new();
                let mut i = 1;
                while text.len() < size {
                    text.push_str(&format!(
                        "{i}. {}\n   https://{}.example.com/{}/{}\n   {}\n",
                        v.phrase(self.rng, 5),
                        v.word(self.rng),
                        v.word(self.rng),
                        v.ident(self.rng),
                        v.prose(self.rng, 160)
                    ));
                    i += 1;
                }
                (json!({ "query": query }), text)
            }
        };
        let call = json!({ "type": "toolCall", "id": format!("call_{}", self.rng.hex(24)), "name": name, "arguments": args });
        (call, json!(name), result)
    }

    fn tool_result(&mut self, call: &Value, text: String) {
        self.advance(1_500.0, 1.2);
        let is_error = self.rng.chance(0.04);
        let mut content = vec![json!({ "type": "text", "text": if is_error { format!("Error: {}", self.vocab.prose(self.rng, 120)) } else { text } })];
        if call["name"] == "read" && self.rng.chance(0.003) {
            content.push(json!({ "type": "image", "data": pika::util::base64url_encode(self.rng.hex(300).as_bytes()).replace(['-', '_'], "A"), "mimeType": "image/png" }));
        }
        let ts = self.t;
        self.message(json!({ "role": "toolResult", "toolCallId": call["id"], "toolName": call["name"], "content": content,
                             "isError": is_error, "timestamp": ts }));
    }

    /// One model call: thinking, optional text, and one or more tool calls (or a subagent call), then the results.
    fn step(&mut self) {
        let mut content: Vec<Value> = self.thinking().into_iter().collect();
        if self.rng.chance(0.4) {
            let bytes = 60 + self.rng.below(200);
            content.push(json!({ "type": "text", "text": self.vocab.prose(self.rng, bytes) }));
        }
        if self.child_due() {
            let (_, child) = self.pending.remove(0);
            let call_id = format!("call_{}", self.rng.hex(24));
            let description = self.vocab.phrase_plus(self.rng, 3, 5);
            let prompt = self.vocab.prose_plus(self.rng, 200, 500);
            let call = json!({ "type": "toolCall", "id": call_id, "name": "Agent",
                               "arguments": { "agent": self.rng.pick(AGENT_TYPES), "description": description, "prompt": prompt } });
            content.push(call.clone());
            self.assistant(content, "toolUse");
            self.spawned.push((child, call_id, self.t + 500));
            let size = self.result_size(1_200.0, 0.6);
            let summary = self.vocab.prose(self.rng, size);
            self.t += self.rng.range(20_000, 600_000);
            self.tool_result(&call, summary);
            return;
        }
        let calls = if self.rng.chance(0.15) { 2 + self.rng.below(2) } else { 1 };
        let mut results = Vec::new();
        for _ in 0..calls {
            let (call, _, result) = self.tool();
            content.push(call.clone());
            results.push((call, result));
        }
        self.assistant(content, "toolUse");
        for (call, result) in results {
            self.tool_result(&call, result);
        }
    }

    fn extras(&mut self) {
        let v = self.vocab;
        if self.name_at_turn == Some(self.turns) {
            let name = v.phrase_plus(self.rng, 3, 4);
            let mut chars = name.chars();
            let name: String = chars.next().into_iter().flat_map(char::to_uppercase).chain(chars).collect();
            self.advance(500.0, 0.5);
            self.entry("session_info", json!({ "name": name }));
        }
        if self.since_compaction >= self.compaction_every {
            self.advance(20_000.0, 0.5);
            let first_kept = self.prev.clone();
            let summary_bytes = 1_000 + self.rng.below(2_500);
            let usage = self.usage(summary_bytes);
            let read_files: Vec<String> = (0..3).map(|_| v.path(self.rng)).collect();
            let modified: Vec<String> = (0..2).map(|_| v.path(self.rng)).collect();
            let summary = v.prose(self.rng, summary_bytes);
            let tokens_before = self.context_tokens + 2_500;
            self.entry(
                "compaction",
                json!({ "summary": summary, "firstKeptEntryId": first_kept, "tokensBefore": tokens_before, "usage": usage,
                        "details": { "readFiles": read_files, "modifiedFiles": modified } }),
            );
            self.context_tokens = (summary_bytes / 4) as i64;
            self.since_compaction = 0;
            if let Some(capture) = &mut self.capture {
                capture.context = vec![json!({ "role": "user", "content": format!("Summary of the conversation so far:\n{summary}"), "timestamp": self.t })];
            }
        }
        match self.rng.below(200) {
            0..=5 => {
                let custom_type = *self.rng.pick(&["pi.virtual-model-state", "loop.state", "autoresearch.state", "statusline.cache"]);
                let data = json!({ "state": v.word(self.rng), "count": self.rng.below(100), "note": v.phrase(self.rng, 4) });
                self.entry("custom", json!({ "customType": custom_type, "data": data }));
            }
            6..=7 => {
                self.notice = Some(v.prose_plus(self.rng, 100, 300));
            }
            8..=9 => {
                let m = &MODELS[self.model];
                let usage = self.usage(0);
                self.entry("usage", json!({ "kind": "cache_warm", "provider": m.provider, "model": m.id, "usage": usage }));
            }
            10 => {
                let target = self.prev.clone();
                let label = v.phrase(self.rng, 2);
                self.entry("label", json!({ "targetId": target, "label": label }));
            }
            _ => {}
        }
    }

    fn turn(&mut self, first_prompt: Option<String>) {
        if self.remaining() > 4 * self.pending.len() + 16 {
            self.extras();
        }
        self.advance(if self.turns == 0 { 3_000.0 } else { 90_000.0 }, 1.2);
        let prompt = first_prompt.unwrap_or_else(|| {
            let bytes = self.rng.lognormal(250.0, 0.9) as usize;
            let mut text = self.vocab.prose(self.rng, bytes);
            if self.rng.chance(0.03) {
                let paste = 4_000 + self.rng.below(16_000);
                text.push_str("\n\n```\n");
                text.push_str(&self.vocab.log(self.rng, paste, &self.project));
                text.push_str("```\n");
            }
            text
        });
        let ts = self.t;
        self.message(json!({ "role": "user", "content": prompt, "timestamp": ts }));
        self.turns += 1;
        let calls = 1 + (self.rng.f64().ln() / 0.75f64.ln()) as usize;
        let mut call = 0;
        while call < calls.min(30) || self.child_due() {
            if self.full() {
                return;
            }
            self.step();
            call += 1;
            if let Some(content) = self.notice.take() {
                self.entry("custom_message", json!({ "customType": "subagent-notification", "content": content, "display": true }));
            }
        }
        let mut content: Vec<Value> = self.thinking().into_iter().collect();
        let bytes = self.rng.lognormal(350.0, 0.8) as usize;
        content.push(json!({ "type": "text", "text": self.vocab.prose(self.rng, bytes) }));
        self.assistant(content, "stop");
    }
}

pub struct Generator<'a> {
    pub plan: &'a Plan,
    pub vocab: &'a Vocab,
}

impl Generator<'_> {
    /// Session ids are fixed by the plan, so a family can name its children before generating them.
    pub fn session_id(&self, index: usize) -> String {
        let mut rng = Rng::fork(SEED ^ 0x1d, index as u64);
        rng.uuid()
    }

    pub fn family(&self, family: &Family) -> FamilyOut {
        let plan = self.plan;
        let vocab = self.vocab;
        let mut rng = Rng::fork(SEED, 1 + family.root as u64);
        let project = plan.projects[family.project].clone();
        let cwd = format!("{}/{project}", HOMES[family.device]);
        let mut out = FamilyOut { device: family.device, streams: Vec::new(), documents: Vec::new() };
        let mut spawns: HashMap<usize, Spawn> = HashMap::new();
        let root_models = Alias::new(ROOT_MODEL_WEIGHTS);
        let child_models = Alias::new(CHILD_MODEL_WEIGHTS);
        let mut run_state: Option<RunState> = None;

        for index in plan.family_sessions(family.root) {
            let sp = &plan.sessions[index];
            let id = self.session_id(index);
            let spawn = spawns.remove(&index);
            let mut start = spawn.as_ref().map_or(family.start_ms, |s| s.start_ms);
            let mut session_cwd = cwd.clone();
            let mut file = session_file(&sessions_dir(&cwd), start, &id);
            let mut header_parent = None;
            let link = match (&sp.role, &spawn) {
                (Role::Root | Role::Orchestrator { .. }, _) => None,
                (Role::Subagent { header_only: true, .. }, Some(spawn)) => {
                    header_parent = Some(spawn.parent_file.clone());
                    None
                }
                (Role::Subagent { workflow, agent_type, .. }, Some(spawn)) => Some(json!({
                    "kind": "subagent", "parentSessionId": spawn.parent_id, "parentSessionFile": spawn.parent_file,
                    "parentToolCallId": spawn.call_id, "agentId": agent_id(&id), "parentAgentId": spawn.parent_agent,
                    "workflowId": workflow, "agentType": agent_type, "description": vocab.phrase(&mut rng, 4),
                })),
                (Role::Step { run, attempt }, Some(spawn)) => {
                    let state = run_state.as_mut().expect("orchestrator before steps");
                    // Steps run one after another.
                    start = start.max(state.t + 30_000);
                    let step = &plan.runs[*run].steps[*attempt];
                    let label = vocab.phrase(&mut rng, 4);
                    state.step_started(&mut rng, plan, *run, *attempt, start, &id, &label);
                    session_cwd = format!("{cwd}/.git/herder/worktrees/{}/{}-{attempt}", state.run_id, step.key);
                    file = session_file(&format!("{cwd}/.git/herder/runs/{}/sessions", state.run_id), start, &id);
                    Some(json!({ "kind": "herder-step", "parentSessionId": spawn.parent_id,
                                 "herder": { "runId": state.run_id, "stepKey": step.key, "stepId": step.key, "task": step.task,
                                             "role": step.role, "attempt": step.attempt, "launch": step.launch, "repo": project } }))
                }
                (_, None) => panic!("session {index} was not started by its parent"),
            };
            let is_child = sp.parent.is_some();
            let model = if is_child { child_models.sample(&mut rng) } else { root_models.sample(&mut rng) };
            let switch_at = rng.chance(0.12).then(|| (sp.size / 3 + rng.below(sp.size / 2 + 1), rng.below(MODELS.len())));
            // Herder starts its steps itself; subagents start at points spread over their parent.
            let mut pending: Vec<(usize, usize)> = match sp.role {
                Role::Orchestrator { .. } => Vec::new(),
                _ => sp.children.iter().map(|&c| (5 + rng.below(sp.size.saturating_sub(10).max(1)), c)).collect(),
            };
            pending.sort();
            let mut g = SessionGen {
                vocab,
                rng: &mut rng,
                size: sp.size,
                project: project.clone(),
                lines: Vec::with_capacity(sp.size),
                prev: None,
                t: start,
                model,
                switch_at,
                context_tokens: 0,
                since_compaction: 0,
                compaction_every: 0,
                name_at_turn: None,
                turns: 0,
                pending,
                spawned: Vec::new(),
                capture: None,
                notice: None,
            };
            g.compaction_every = g.rng.range(150, 450) as usize;
            g.name_at_turn = g.rng.chance(0.4).then(|| g.rng.below(3));
            let mut header = json!({ "type": "session", "version": 3, "id": id, "timestamp": format_iso_ms(start), "cwd": session_cwd });
            if let Some(parent) = &header_parent {
                header["parentSession"] = json!(parent);
            }
            g.lines.push(header.to_string());
            let m = &MODELS[model];
            g.t += 5;
            g.entry("model_change", json!({ "provider": m.provider, "modelId": m.id }));
            if let Some(link) = link {
                g.entry("custom", json!({ "customType": "pi-extensions.session-link", "data": strip_nulls(link) }));
            }
            if g.rng.chance(0.3) {
                let level = *g.rng.pick(&["low", "medium", "high"]);
                g.entry("thinking_level_change", json!({ "thinkingLevel": level }));
            }
            let system = system_prompt(vocab, g.rng, &session_cwd);
            if sp.requests {
                let tools = tool_defs(vocab, g.rng);
                g.capture = Some(Capture { system: system.clone(), tools, context: Vec::new(), seq: 0, sent: HashSet::new(), out: Vec::new() });
            }
            let ts = g.t;
            g.entry("message", json!({ "message": { "role": "system", "content": "", "sections": { "preamble": system }, "timestamp": ts } }));
            let mut first = true;
            while !g.full() {
                let prompt = (first && is_child).then(|| vocab.prose_plus(g.rng, 300, 600));
                first = false;
                g.turn(prompt);
            }
            assert!(g.pending.is_empty() && g.lines.len() == sp.size, "session {index} did not start all its children");
            let SessionGen { lines, spawned, t: end, capture, .. } = g;

            let parent_agent = matches!(sp.role, Role::Subagent { .. }).then(|| agent_id(&id));
            for (child, call_id, at) in spawned {
                let spawn = Spawn {
                    parent_id: id.clone(),
                    parent_file: file.clone(),
                    call_id: Some(call_id),
                    parent_agent: parent_agent.clone(),
                    start_ms: at,
                };
                spawns.insert(child, spawn);
            }
            match sp.role {
                Role::Orchestrator { run } => {
                    let mut title = vocab.phrase_plus(&mut rng, 3, 4);
                    title[..1].make_ascii_uppercase();
                    let mut state = RunState::new(&mut rng, &title, &id, &cwd, start + 30_000);
                    state.begin(&mut rng, vocab, &mut out.documents);
                    for step in &plan.runs[run].steps {
                        let spawn = Spawn { parent_id: id.clone(), parent_file: file.clone(), call_id: None, parent_agent: None, start_ms: state.t };
                        spawns.insert(step.session, spawn);
                    }
                    run_state = Some(state);
                }
                Role::Step { run, attempt } => {
                    let state = run_state.as_mut().expect("orchestrator before steps");
                    state.step_ended(&mut rng, plan, run, attempt, end, &id, &file);
                }
                Role::Root | Role::Subagent { .. } => {}
            }
            out.streams.push(StreamOut {
                key: format!("session:{id}"),
                kind: "session",
                path: file,
                lines,
                requests: capture.map(|c| c.out).unwrap_or_default(),
            });
        }
        if let Some(mut state) = run_state {
            let run = match plan.sessions[family.root].role {
                Role::Orchestrator { run } => run,
                _ => unreachable!(),
            };
            state.finish(&mut rng, plan.runs[run].finished);
            out.streams.push(StreamOut {
                key: format!("herder:{}", state.run_id),
                kind: "herder-journal",
                path: format!("{cwd}/.git/herder/runs/{}/journal.jsonl", state.run_id),
                lines: state.lines,
                requests: Vec::new(),
            });
        }
        out
    }
}

fn agent_id(session_id: &str) -> String {
    format!("agent-{}", &session_id[..8])
}

fn strip_nulls(v: Value) -> Value {
    match v {
        Value::Object(obj) => Value::Object(obj.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k, strip_nulls(v))).collect()),
        other => other,
    }
}

/// A Herder run's journal as its steps run.
struct RunState {
    run_id: String,
    lines: Vec<String>,
    t: i64,
    head: String,
}

impl RunState {
    fn new(rng: &mut Rng, title: &str, orchestrator_id: &str, repo: &str, t: i64) -> RunState {
        let iso = format_iso_ms(t);
        let run_id = format!("{}{}{}-{}{}{}-{}", &iso[0..4], &iso[5..7], &iso[8..10], &iso[11..13], &iso[14..16], &iso[17..19], rng.hex(4));
        let mut state = RunState { run_id, lines: Vec::new(), t, head: rng.hex(40) };
        let base = state.head.clone();
        state.event("run.started", json!({ "runId": state.run_id, "title": title, "base": base, "runtime": "1.4.0", "repo": repo,
                                           "sessionId": orchestrator_id }));
        state
    }

    fn event(&mut self, t: &str, fields: Value) {
        let mut obj = Map::new();
        obj.insert("v".into(), json!(1));
        obj.insert("t".into(), json!(t));
        obj.insert("at".into(), json!(format_iso_ms(self.t)));
        if let Value::Object(fields) = fields {
            obj.extend(fields);
        }
        self.lines.push(Value::Object(obj).to_string());
    }

    fn begin(&mut self, rng: &mut Rng, vocab: &Vocab, documents: &mut Vec<DocumentOut>) {
        let goal = format!("# Goal\n\n{}\n\n## Acceptance criteria\n\n{}\n", vocab.prose(rng, 800), vocab.prose(rng, 1_200));
        let plan = format!("# Plan\n\n{}\n\n## Tasks\n\n{}\n", vocab.prose(rng, 1_500), vocab.prose(rng, 2_500));
        self.t += 60_000;
        self.event("goal.approved", json!({ "sha256": sha256_hex(goal.as_bytes()), "checks": [{ "id": "test", "command": "npm test", "timeoutMs": 600_000, "integrate": true }], "approvedBy": "user" }));
        self.t += 60_000;
        self.event("plan.updated", json!({ "sha256": sha256_hex(plan.as_bytes()) }));
        self.t += 30_000;
        let head = self.head.clone();
        self.event("script.launched", json!({ "launch": 1, "scriptSha256": rng.hex(64), "args": null, "head": head }));
        for (name, kind, content) in [("goal.md", "herder-goal", goal), ("plan.md", "herder-plan", plan)] {
            documents.push(DocumentOut { key: format!("herder:{}:{name}", self.run_id), kind, run_id: self.run_id.clone(), content });
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn step_started(&mut self, rng: &mut Rng, plan: &Plan, run: usize, attempt: usize, at: i64, session_id: &str, label: &str) {
        let r = &plan.runs[run];
        let step = &r.steps[attempt];
        if r.resume_at == Some(attempt) {
            self.t = self.t.max(at - 120_000);
            let head = self.head.clone();
            self.event("script.launched", json!({ "launch": 2, "scriptSha256": rng.hex(64), "args": null, "head": head }));
        }
        self.t = self.t.max(at - 1_000);
        let base = self.head.clone();
        self.event(
            "step.started",
            json!({ "key": step.key, "id": step.key, "occurrence": 0, "fingerprint": rng.hex(16), "attempt": step.attempt,
                    "role": step.role, "write": step.role == "worker", "base": base, "task": step.task, "launch": step.launch,
                    "label": label, "phase": if step.role == "worker" { "build" } else { "review" }, "sessionId": session_id }),
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn step_ended(&mut self, rng: &mut Rng, plan: &Plan, run: usize, attempt: usize, at: i64, session_id: &str, file: &str) {
        let step = &plan.runs[run].steps[attempt];
        self.t = self.t.max(at + 1_000);
        match step.outcome {
            Outcome::Ok => {
                let commit = (step.role == "worker").then(|| rng.hex(40));
                self.event("step.completed", json!({ "key": step.key, "fingerprint": rng.hex(16), "status": "ok", "commit": commit,
                                                     "sessionId": session_id, "sessionFile": file }));
                if let Some(commit) = commit {
                    self.t += 5_000;
                    let from = self.head.clone();
                    self.head = rng.hex(40);
                    let head = self.head.clone();
                    self.event("integrate.completed", json!({ "key": step.key, "from": from, "source": commit, "head": head, "tree": rng.hex(40),
                                                              "message": format!("feat: {}", step.task), "task": step.task, "checks": [] }));
                }
            }
            Outcome::Retry => {
                self.event("step.failed", json!({ "key": step.key, "fingerprint": rng.hex(16), "attempt": step.attempt, "errorClass": "transient",
                                                  "message": "rate limited", "final": false, "sessionId": session_id, "sessionFile": file }));
            }
            Outcome::Stopped => {
                self.event("step.failed", json!({ "key": step.key, "fingerprint": rng.hex(16), "attempt": step.attempt, "errorClass": "stopped",
                                                  "message": "stopped by user", "final": true, "sessionId": session_id, "sessionFile": file }));
            }
        }
    }

    fn finish(&mut self, rng: &mut Rng, finished: bool) {
        if finished {
            self.t += 60_000;
            let head = self.head.clone();
            self.event("verify.completed", json!({ "head": head, "checks": [], "verdict": "met", "criteria": [], "verifierRan": true }));
            self.t += 60_000;
            self.event("delivery.completed", json!({ "mode": "series", "target": "main", "tip": head, "commits": [rng.hex(40)] }));
            self.t += 1_000;
            self.event("run.finished", json!({ "status": "delivered", "reason": "done" }));
        }
    }
}
