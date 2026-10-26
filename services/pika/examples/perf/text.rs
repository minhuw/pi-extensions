//! Text for generated sessions: a Zipf-distributed vocabulary of about 30,000 words, plus prose, code, logs, and
//! code-like identifiers and paths built from it.

use std::collections::HashSet;

use crate::rng::{Alias, Rng};

pub const VOCABULARY: usize = 30_000;
const ZIPF_S: f64 = 1.0;

/// The most frequent words, in rank order, before the generated ones.
const COMMON: &str = "the to and of a in is it that for this on with be as not we you are can if or but from by \
    at an have will do so there what when which all use one should then just now also file test code error function \
    value type run need check let new make like here get see would more change set return first it's into only add \
    call where because time build data line same name case before after other still path config fix update read \
    write output input string list version issue work how way result them out update their some could any these \
    those back current both each instead without about over default already next does into module branch commit \
    server client request response session model tool command script message event state field method class \
    struct impl trait crate package import export const async await test tests failing passes fails flaky looks \
    seems probably might since while until though however again open close start stop handle handler parse \
    parser render query index cache table column row schema migration database token user users page cursor \
    limit offset sort filter search match pattern regex buffer stream batch upload download local remote path \
    directory folder repo repository worktree diff patch review reviewer worker agent subagent plan goal step \
    task verify verified approve approved deliver delivered launch resumed retry attempt timeout latency \
    memory allocation thread lock mutex channel queue spool retry backoff network socket header body json yaml \
    toml markdown docs readme comment comments warning warnings compile compiler linker binary release debug";

const ONSETS: &[&str] = &[
    "b", "c", "d", "f", "g", "h", "j", "k", "l", "m", "n", "p", "r", "s", "t", "v", "w", "z", "br", "ch", "cl", "cr",
    "dr", "fl", "fr", "gl", "gr", "pl", "pr", "sc", "sh", "sk", "sl", "sn", "sp", "st", "str", "th", "tr", "wh",
];
const VOWELS: &[&str] = &["a", "e", "i", "o", "u", "ai", "ea", "ee", "io", "oa", "ou", "y"];
const CODAS: &[&str] = &["", "", "", "n", "r", "s", "t", "l", "m", "nd", "nt", "st", "rk", "ck", "ng", "x"];

/// Fixed phrases that recur in prose, as real projects repeat their own jargon; quoted-phrase searches use them.
pub const IDIOMS: &[&str] = &[
    "the flaky test", "race condition in the scheduler", "type mismatch error", "cache invalidation bug",
    "off by one error", "the build is green", "missing trailing newline", "permission denied while opening",
    "connection reset by peer", "the migration failed", "stack overflow in the parser", "memory leak in the worker",
    "snapshot tests are outdated", "the lockfile changed", "unused import warning", "deadlock on the session lock",
    "retry with exponential backoff", "invalid utf-8 sequence", "the cursor skips a row", "timeout waiting for the server",
];

pub struct Vocab {
    pub words: Vec<String>,
    zipf: Alias,
}

impl Vocab {
    /// The same vocabulary for every seed: ranks are stable, so the bench can name common and rare words.
    pub fn new() -> Vocab {
        let mut words: Vec<String> = Vec::with_capacity(VOCABULARY);
        let mut seen = HashSet::new();
        for word in COMMON.split_whitespace() {
            if seen.insert(word.to_owned()) {
                words.push(word.to_owned());
            }
        }
        let mut rng = Rng::new(0x766f_6361_6275_6c61);
        while words.len() < VOCABULARY {
            // Longer words get rarer, as in natural text.
            let syllables = match words.len() {
                0..2_000 => 1 + rng.below(2),
                2_000..12_000 => 2 + rng.below(2),
                _ => 2 + rng.below(3),
            };
            let mut word = String::new();
            for _ in 0..syllables {
                word.push_str(rng.pick(ONSETS));
                word.push_str(rng.pick(VOWELS));
            }
            word.push_str(rng.pick(CODAS));
            if word.len() >= 3 && seen.insert(word.clone()) {
                words.push(word);
            }
        }
        Vocab { zipf: Alias::zipf(words.len(), ZIPF_S), words }
    }

    pub fn word(&self, rng: &mut Rng) -> &str {
        &self.words[self.zipf.sample(rng)]
    }

    /// Prose of about `bytes` bytes: sentences with occasional inline code.
    pub fn prose(&self, rng: &mut Rng, bytes: usize) -> String {
        let mut out = String::with_capacity(bytes + 64);
        while out.len() < bytes {
            if !out.is_empty() {
                out.push(if rng.chance(0.12) { '\n' } else { ' ' });
            }
            let words = 5 + rng.below(16);
            let idiom_at = rng.chance(0.03).then(|| rng.below(words));
            for i in 0..words {
                if idiom_at == Some(i) {
                    if i > 0 {
                        out.push(' ');
                    }
                    out.push_str(rng.pick(IDIOMS));
                    continue;
                }
                if i > 0 {
                    out.push(' ');
                }
                if rng.chance(0.04) {
                    out.push('`');
                    if rng.chance(0.5) {
                        out.push_str(&self.ident(rng));
                    } else {
                        out.push_str(&self.path(rng));
                    }
                    out.push('`');
                    continue;
                }
                let word = self.word(rng);
                if i == 0 {
                    let mut chars = word.chars();
                    if let Some(first) = chars.next() {
                        out.extend(first.to_uppercase());
                        out.push_str(chars.as_str());
                    }
                } else {
                    out.push_str(word);
                }
            }
            out.push(*rng.pick(&['.', '.', '.', '?', ':']));
        }
        out
    }

    /// `phrase` of `n` plus up to `extra - 1` words.
    pub fn phrase_plus(&self, rng: &mut Rng, n: usize, extra: usize) -> String {
        let n = n + rng.below(extra);
        self.phrase(rng, n)
    }

    /// `prose` of `bytes` plus up to `extra - 1` bytes.
    pub fn prose_plus(&self, rng: &mut Rng, bytes: usize, extra: usize) -> String {
        let bytes = bytes + rng.below(extra);
        self.prose(rng, bytes)
    }

    /// `code` of `bytes` plus up to `extra - 1` bytes.
    pub fn code_plus(&self, rng: &mut Rng, bytes: usize, extra: usize) -> String {
        let bytes = bytes + rng.below(extra);
        self.code(rng, bytes)
    }

    /// A short phrase of `n` words, as for titles and search queries.
    pub fn phrase(&self, rng: &mut Rng, n: usize) -> String {
        (0..n).map(|_| self.word(rng)).collect::<Vec<_>>().join(" ")
    }

    pub fn ident(&self, rng: &mut Rng) -> String {
        let parts = 1 + rng.below(3);
        let words: Vec<&str> = (0..parts).map(|_| self.word(rng)).collect();
        if rng.chance(0.3) {
            let mut out = words[0].to_owned();
            for w in &words[1..] {
                let mut chars = w.chars();
                if let Some(first) = chars.next() {
                    out.extend(first.to_uppercase());
                    out.push_str(chars.as_str());
                }
            }
            out
        } else {
            words.join("_")
        }
    }

    pub fn type_name(&self, rng: &mut Rng) -> String {
        let w = self.word(rng);
        let mut chars = w.chars();
        let mut out = String::new();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
        out
    }

    pub fn path(&self, rng: &mut Rng) -> String {
        let dirs = rng.below(3);
        let mut out = (*rng.pick(&["src", "src", "lib", "tests", "extensions", "services", "web/src", "docs"])).to_owned();
        for _ in 0..dirs {
            out.push('/');
            out.push_str(self.word(rng));
        }
        out.push('/');
        out.push_str(&self.ident(rng).to_lowercase());
        out.push_str(rng.pick(&[".rs", ".ts", ".ts", ".tsx", ".md", ".json", ".py", ".go", ".toml"]));
        out
    }

    /// Source code of about `bytes` bytes.
    pub fn code(&self, rng: &mut Rng, bytes: usize) -> String {
        let mut out = String::with_capacity(bytes + 128);
        let mut depth = 0usize;
        while out.len() < bytes {
            let indent = "    ".repeat(depth);
            let line = match rng.below(12) {
                0 if depth < 3 => {
                    depth += 1;
                    format!(
                        "{indent}fn {}({}: &{}) -> Result<{}> {{",
                        self.ident(rng).to_lowercase(),
                        self.ident(rng).to_lowercase(),
                        self.type_name(rng),
                        self.type_name(rng)
                    )
                }
                1 if depth < 3 => {
                    depth += 1;
                    format!("{indent}if {}.{}() {{", self.ident(rng), self.ident(rng))
                }
                2 | 3 if depth > 0 => {
                    depth -= 1;
                    format!("{}}}", "    ".repeat(depth))
                }
                4 => format!("{indent}// {}", self.phrase_plus(rng, 4, 8)),
                5 => format!("{indent}return Err(anyhow!(\"{} {{}}\", {}));", self.phrase(rng, 3), self.ident(rng)),
                6 => format!("{indent}const {}: usize = {};", self.ident(rng).to_uppercase(), rng.below(100_000)),
                _ => format!(
                    "{indent}let {} = {}.{}({}, {})?;",
                    self.ident(rng).to_lowercase(),
                    self.ident(rng),
                    self.ident(rng).to_lowercase(),
                    self.ident(rng),
                    rng.below(1000)
                ),
            };
            out.push_str(&line);
            out.push('\n');
        }
        out
    }

    /// Command output of about `bytes` bytes: build logs, test results, and errors.
    pub fn log(&self, rng: &mut Rng, bytes: usize, project: &str) -> String {
        let mut out = String::with_capacity(bytes + 128);
        while out.len() < bytes {
            let line = match rng.below(10) {
                0 => format!("   Compiling {} v0.{}.{} (/home/me/code/{project})", self.word(rng), rng.below(20), rng.below(10)),
                1 | 2 => format!(
                    "test {}::{} ... {}",
                    self.ident(rng).to_lowercase(),
                    self.ident(rng).to_lowercase(),
                    if rng.chance(0.93) { "ok" } else { "FAILED" }
                ),
                3 => format!("error[E0{}]: {}", 100 + rng.below(800), self.phrase_plus(rng, 4, 6)),
                4 => format!("  --> {}:{}:{}", self.path(rng), 1 + rng.below(900), 1 + rng.below(80)),
                5 => format!("warning: {} `{}`", self.phrase_plus(rng, 3, 4), self.ident(rng)),
                6 => format!(
                    "{:02}:{:02}:{:02}.{:03} INFO {} {}={}",
                    rng.below(24),
                    rng.below(60),
                    rng.below(60),
                    rng.below(1000),
                    self.phrase_plus(rng, 3, 5),
                    self.ident(rng),
                    rng.hex(8)
                ),
                7 => format!("{} | {}", 1 + rng.below(500), self.code(rng, 40).trim_end()),
                _ => self.prose_plus(rng, 40, 80),
            };
            out.push_str(&line);
            out.push('\n');
        }
        out
    }
}
