# Upstream provenance

`extensions/fff/` is derived from [`dmtrKovalenko/fff`](https://github.com/dmtrKovalenko/fff) (`packages/pi-fff`), pinned to:

- `@ff-labs/pi-fff@0.11.0`
- `@ff-labs/fff-node@0.11.0`

Upstream is Copyright (c) Dmitry Kovalenko and contributors under the MIT License (`LICENSE`).

## Ported vs adapted components

- **Preserved verbatim / schema-compatible:** `pi-fff.schema.json`, `<agentDir>/pi-fff.json` startup validation (`config.ts`), LMDB path resolution (`paths.ts`), query/exclude normalization and outside-workspace path routing (`query.ts`), tool names/schemas/formatting (`fffind`, `ffgrep`, opt-in `fff-multi-grep`, and `override` equivalents), `@` file mention autocomplete, and `/fff-mode`, `/fff-health`, `/fff-rescan`.
- **Replaced locally:** direct in-process `FileFinder` lifecycle (`sdk.ts`, `file-picker.ts`, `aux-finders.ts` pool) is replaced by an out-of-process Node IPC sidecar (`sidecar.mjs`) and a process-wide canonical-`cwd` shared backend pool (`client.ts`). See `LOCAL-PATCHES.md` for details.
