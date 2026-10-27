# pika performance check

`bash services/pika/scripts/perf.sh` checks AC-7: with one year of data from five machines, the filtered session
list answers in p95 < 100 ms, the first page of a 5,000-entry session in p95 < 200 ms per request, the session's
trace in p95 < 200 ms, and search in p95 < 300 ms. It needs about 12 GiB of free disk in `$TMPDIR` and takes about 12 minutes on an Apple Silicon Mac,
most of it loading.

The script:

1. builds `pika` and the `perf` example in release mode (`CARGO_TARGET_DIR` defaults to `~/.cache/pika-target`);
2. `perf load` generates the dataset and loads it through `pika::ingest::apply` into a temporary data dir;
3. `perf check` checks the dataset's shape from the database's own counts and fails when it falls short;
4. starts `pika serve` on a free localhost port;
5. `perf bench` measures the read API over one keep-alive HTTP/1.1 connection and prints a table and one
   `{"pikaPerf": ...}` JSON line;
6. removes the data dir and stops the server on every exit path.

It exits non-zero when the shape check fails or a class exceeds its limit. `PIKA_PERF_SCALE=0.05` runs a smaller
dataset of the same shape for trying the scripts; the bench then still applies the limits, but the shape check
expects the smaller size. `perf bench --only search --samples 100` measures one section of a running server for
investigation; such partial runs never pass.

## Dataset

Deterministic (fixed seeds), following pi's session format:

- 10,000 sessions and 2.56M entries over the year from 2025-10-26, on 5 devices, 40 projects, and 6 models;
- session sizes long-tailed around an average of 256 entries, plus five sessions of exactly 5,000 entries and two
  of 20,000;
- a header, a model change, a system message, user prompts, assistant messages with thinking, text, and tool calls
  (bash, read, edit, write, codemode, web_search, Agent) with usage and cost, and tool results with a median of about
  1 KiB (log-normal, with some around 50 KiB); compactions, `session_info` names, custom and custom-message entries,
  usage entries, labels, model switches, tool errors, and a few images;
- 30% of the sessions are children: subagents with link entries (some nested or in workflows, some linked only by
  the header's `parentSession`) and Herder step sessions; 20 Herder runs with journals, goals, and plans, some
  retried or resumed in a second launch;
- prose, code, and logs from a Zipf-distributed vocabulary of 30,000 words with code-like identifiers and paths, and
  some recurring phrases;
- captured model requests (skeleton and blocks) for every model call of 50 sessions.

Devices upload as they would live: each batch holds one device's next 64 lines of every stream it has open, so the
lines of concurrent sessions interleave in the database.

## Measurement

Each class runs warm-up requests first, then at least 400 measured sequential requests with randomized parameters
from a fixed seed. Times run from the first request byte to the last response byte.

| Class | Requests | Limit (p95) |
| --- | --- | --- |
| session list | `sessions?limit=50`: no filter, root only, device, project, model, a date range, and combinations; some followed by their second page | < 100 ms |
| 5,000-entry session | `sessions/:id`, `sessions/:id/turns`, `sessions/:id/entries?from=0&limit=200`, and `sessions/:id/trace` with `Accept-Encoding: gzip`, each a class | < 200 ms each |
| search | common words, rare words, two words, and quoted phrases; with no filter, device, project, or both; newest first and by relevance | < 300 ms |

The same requests for the 20,000-entry sessions are reported for information. The report also gives the raw and
gzipped size of one 5,000-entry session's trace, the load time and rate, the database and blob store sizes, and the
server's peak RSS.

## What the check found

Search with a device or project filter joined every match to its document and session before filtering: a common
word with a selective filter read most of `search_docs` (38 s for one query). Relevance computed its window and its
ranking in two passes, and SQLite drove the final join from the full-text index rather than from the best rows.

- A document id carries the low 20 bits of its session's sid. Filtered searches first test those bits against the
  filtered sessions' sids, from a set SQLite builds once per query; only matches that pass are joined. The bits
  identify the session while every sid is below 2^20; past that, the exact join runs too. Relevance also applies the
  exact filters in its final join, which costs at most `limit` lookups. Applying them in the scored window instead
  joined up to 20,000 matches each and raised filtered relevance p95 from about 110 ms to 1.1 s for common words.
- A colliding document id steps within its second's low 12 bits, and once all 4,096 are taken it moves to the next
  second, so it never carries into the sid bits.
- Relevance scores the newest 20,000 filtered matches in one pass and joins and snippets only the best `limit`,
  each looked up by rowid (`CROSS JOIN` keeps that order).
- A filter that no session passes returns an empty page without searching.

The trace reads every model call, tool call, and turn of the session by primary key, and the line of each assistant
message, for its first text, thinking, and `durationMs`, with a typed parse that skips tool arguments without building
values. Compactions and branch summaries come from a walk of the session's derived `entries` rows by primary key with
a type filter, about 1 ms for 5,000 entries, so no type index is needed. Most of the trace's time is reading the
assistant lines and compressing: gzip at the default level takes about 20 ms for the 1.5 MB trace of a 5,000-entry
session and makes it 25% smaller than the fastest level. Serializing goes into the encoder through a 64 KiB buffer;
without one, each of serde's small writes ran the compressor and a trace took seven times as long.

The trace has no response cap: it grows linearly with the session, at about 340 bytes of JSON per record (about 85
bytes gzipped on this generated text). A 5,000-entry session has about 4,500 records and a 1.5 MB trace (370 KiB
gzipped); a 20,000-entry session has about 18,000 records and a 6.1 MB trace (1.5 MB gzipped), which takes about
140 ms. A live view polls the trace every 3 s, so each response carries an `ETag` from a fingerprint query (the
session's and its children's entry counts and times, its request count, and the reindex generation; see the spec),
and a poll of an unchanged session gets `304 Not Modified` in under 0.5 ms without building the trace. Arguments are
summarized from a borrowed parse that decodes only the strings a summary uses, and blob-stored lines are decompressed
only up to 4 MiB; with these, the 5,000-entry trace takes the same time as before (p50 32 ms against 33 ms through
HTTP with gzip, on a 0.04-scale dataset whose large sessions are full size).

`src/read/plans.rs` pins the query plans of the hot queries, so a regression fails `cargo test`.

## Latest results

On an Apple Silicon Mac mini (10 cores) on 2026-10-27, while another build ran on the machine, the whole script took
14.5 minutes; loading was slower than in earlier runs (762 s against 492 s):

```
query class                      n    p50 ms    p95 ms    max ms     limit  result
session list                 480       0.2       0.8       5.4     < 100  ok
5k session: sessions/:id     400       0.2       0.3       1.7     < 200  ok
5k session: turns            400       0.5       0.7       9.5     < 200  ok
5k session: entries          400       1.3       1.8      64.3     < 200  ok
5k session: trace            400      34.0      43.2     187.1     < 200  ok
20k session: sessions/:id    100       0.4       0.5       1.8         -  info
20k session: turns           100       0.6       0.9       5.7         -  info
20k session: entries         100       1.4       2.1      10.7         -  info
20k session: trace           100     143.1     171.3     238.6         -  info
search                       400      14.2     131.7     427.7     < 300  ok

subclass                               n    p50 ms    p95 ms    max ms
session list: combination          225       0.2       0.9       2.0
session list: dates                134       0.3       1.1       1.3
session list: device               152       0.2       0.9       2.0
session list: model                112       0.3       1.2       2.0
session list: no filter            41       0.2       0.3       0.4
session list: project              137       0.2       0.5       0.8
session list: root                 164       0.2       0.9       1.3
session list: second page          80       0.2       0.8       5.4
search: common newest              62       2.8      28.9      57.9
search: common relevance           26      42.7     114.3     119.7
search: filter all                 113      15.8     133.7     427.7
search: filter device              93      14.9     136.1     306.6
search: filter device+project      87       3.8     119.7     181.9
search: filter project             107      19.1     138.2     302.5
search: phrase newest              60      17.8      91.7     181.9
search: phrase relevance           47     119.7     302.5     427.7
search: rare newest                64       9.7      15.3      24.3
search: rare relevance             37      13.4      25.2      28.3
search: two-word newest            69      16.5      41.5     131.7
search: two-word relevance         35      30.1      69.6     149.7

load: 762.4 s, 2560663 entries, 3359 entries/s, 3425 MiB of lines
5k session trace: 4498 records, 1473 KiB raw, 371 KiB gzipped
database: 10497 MiB, blob store: 12 MiB, server peak RSS: 344 MiB
```

The generated text is random words with random call ids, so the trace compresses about 4x here; real sessions
repeat more. The peak RSS rose from 50 MiB to 344 MiB with the 20,000-entry traces (about 6 MB of JSON each): macOS's
allocator keeps the freed large buffers (`Malloc Large (empty)` in `vmmap`) and returns them later, and a run of other
large responses brought the server back to about 65 MiB in a separate check. Traces of 5,000-entry sessions alone kept
it near 60 MiB.

Before the search changes, one filtered search of a common word took 38 s, and the first full run had not finished
its searches after 10 minutes; the other classes were already well within their limits. The slowest searches are
relevance-sorted quoted phrases of common words: the window's 20,000 newest matches need position checks over many
candidate documents and a bm25 score each, so that subclass alone sits near the class limit.
