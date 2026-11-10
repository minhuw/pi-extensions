# Workspace

Workspace keeps agent file writes inside the current project (`<cwd>`), gives side checkouts and scratch directories a predictable home under `<cwd>/.pi/workspaces/<name>`, and guards against unapproved writes to `~/projects` or other directories outside the project.

The collection loads this extension automatically; use `/reload` after installing or updating it.

```text
/workspace                            list project workspaces, safety states, and allowed external paths
/workspace list                       list project workspaces, safety states, and allowed external paths
/workspace gc [--dry-run] [--yes] [--all]   clean up SAFE workspaces and review REVIEW workspaces
/workspace allow <path>               allow writes to an external path for this project
/workspace deny <path>                revoke an allowed external path for this project
/workspace pin <name>                 pin a workspace so garbage collection never removes it
/workspace unpin <name>               unpin a workspace
```

## Project-closure model and `/tmp`

When a session starts or runs a prompt, the extension ensures `<cwd>/.pi/workspaces/` exists with a local `<cwd>/.pi/workspaces/.gitignore` containing `*`. Every side workspace under `<cwd>/.pi/workspaces/<name>` is ignored by Git automatically without creating or modifying `<cwd>/.gitignore`.

At `before_agent_start`, the extension adds a `<workspace>` system prompt section instructing the model to:

- keep project file writes inside `<cwd>`,
- place side git clones, linked worktrees, and isolated experiments under `<cwd>/.pi/workspaces/<name>` (or create them with the `workspace` tool),
- use `/tmp` for ephemeral temporary files, and
- never create or modify directories in `~/projects` or other paths outside `<cwd>` without explicit user approval.

Touching any path under `<cwd>/.pi/workspaces/<name>` through `write`, `edit`, or `bash` automatically ensures `<cwd>/.pi/workspaces/.gitignore` (`*`) exists and registers `<name>` in `<cwd>/.pi/workspaces/.registry.json`.

## External path confirmation

The extension inspects `write`, `edit`, and mutating `bash` tool calls (`mkdir`, `touch`, `rm`, `rmdir`, `cp`, `mv`, `ln`, `install`, `tee`, `dd of=`, `tar -C`/`-cf`, `unzip -d`, `git clone`, `git init`, `git worktree add`, `cargo new`/`init`, `npm`/`pnpm`/`yarn` `--prefix`/`-C`/`--dir`/`--cwd`, `cd <dir> && ...`, and shell output redirections `>`, `>>`, `>|`, `&>`, `&>>`, and `<>`).

All candidate paths are canonicalized before evaluation:

- A leading `~` is expanded in a `write` or `edit` `path`; `$HOME` and `${HOME}` are not.
- A word of a `bash` command is read the way bash reads it, and the result is final: it is resolved as written and never expanded again.
  - `$HOME` and `${HOME}` become the home directory, bare or inside double quotes: `$HOME/f`, `"${HOME}/f"`.
  - `~` becomes the home directory when it starts the word, nothing quotes it, and `/` or the end of the word follows: `~`, `~/f`. The same holds right after the first `=` of a word whose text before that `=` is a variable name: `dd of=~/f`, but not `--out=~/f`.
  - A quoted or escaped `~`, `$HOME`, or space is literal, and nothing is trimmed: `'~/f'`, `"~/f"`, and `\~/f` name a file in a directory named `~` under `<cwd>`, `'$HOME/f'` and `\$HOME/f` a file in a directory named `$HOME`, and `' f'` a file whose name starts with a space. Quote characters inside quotes stay: `"'q'"` is `'q'`.
  - Every other expansion keeps its source text; see [Limits](#limits).
- A `write` or `edit` `path` is first normalized the way Pi's file tools resolve it: Unicode spaces become plain spaces, one leading `@` is dropped, and a `file://` URL becomes its filesystem path, so `@/x/f` and `file:///x/f` are judged as `/x/f`. A `file://` URL that names no local file is blocked. After that normalization the path is taken literally, with no trimming, quote stripping, or `$HOME` expansion, as in Pi: `$HOME/f` is a file in a directory named `$HOME` under `<cwd>`, and ` f` is a file whose name starts with a space. Words in `bash` commands keep `@` and `file:` literal.
- Symlinks are resolved through the deepest existing ancestor on disk, so a symlink inside `<cwd>` that points outside `<cwd>` is evaluated by its real external target. A link's target text is read literally, as the OS reads it.
- Writes inside `<cwd>` (including `<cwd>/.pi/workspaces/<name>`), the repository's git common directory, `/tmp` (and `os.tmpdir()`), and paths in the session or project allowlist succeed without prompting, except for the two [guard state files](#guard-state-files).

When a tool call targets an unapproved path outside `<cwd>` and `/tmp`:

- **Interactive top-level sessions (`hasUI: true`):** Pi prompts with `ctx.ui.select`:
  - `Allow once` — permits this single tool call only.
  - `Allow for this session` — permits exactly the path the prompt shows for the rest of the current session and any child sessions it spawns.
  - `Allow for this project` — records exactly the path the prompt shows in `<cwd>/.pi/workspaces/policy.json` (`allowedPaths`) and permits it across sessions for this project.
  - `Deny` — blocks the tool call and directs the model to `<cwd>/.pi/workspaces/<name>` or `/tmp`.

  The prompt title, `Allow write outside workspace (<path>)?`, names the canonical path, and `Allow for this session` and `Allow for this project` cover that path only, never its parent directory: after `~/notes/a.txt` is allowed, a later write to `~/notes/a.txt` does not prompt and a write to `~/notes/b.txt` prompts again. When the path shown is a directory (for example the target of `mkdir` or `cp`), allowing it allows everything under it. To allow a directory when the prompt shows a file, run `/workspace allow <dir>`. The approval is stored and matched as the exact path the prompt shows, with no trimming, quote stripping, or `~` / `$HOME` expansion, and `allowedPaths` entries in `policy.json` are absolute paths taken as written (a hand-written `~/x` or `$HOME/x` entry is not expanded; use `/workspace allow <path>` to expand `~` or `$HOME` before saving).
- **Child sessions and non-interactive sessions (`print`, `json`):** While any top-level session is open, the extension registers itself in `globalThis[Symbol.for("pi-extensions.child-session-hooks")]` and removes the hook when all sessions shut down. Child sessions (including sessions carrying a `pi-extensions.session-link` entry) inherit the active session and project allowlists, and immediately block unapproved external writes without prompting.

### Guard state files

`<cwd>/.pi/workspaces/policy.json` (the project allowlist) and `<cwd>/.pi/workspaces/.registry.json` (the workspace registry that `/workspace gc` reads) are written only by the extension: `/workspace allow`, `/workspace deny`, `/workspace pin`, `/workspace unpin`, `/workspace gc`, the `workspace` tool, automatic workspace registration, and the `Allow for this project` choice.

A `write`, `edit`, or `bash` call whose target resolves to either file is blocked without a prompt in interactive, non-interactive, and child sessions, so the model cannot approve its own external writes. The target is compared by canonical path, ignoring letter case (macOS resolves `POLICY.JSON` to the same file), so a relative, absolute, `..`, or symlinked spelling is caught. No session or project allowlist entry unblocks these files, including an entry for `<cwd>/.pi/workspaces` or for the file itself. The block reason says that the file is managed by the workspace extension and that the user changes it with `/workspace allow <path>` or `/workspace deny <path>`. Other writes under `<cwd>/.pi/workspaces/`, such as workspace directories and their contents, stay allowed.

For `bash`, the block does not depend on recognizing the writing command. A write redirection onto either file (`cat a > .pi/workspaces/policy.json`) and every target of the command list above are blocked whatever the verb. Beyond those, a call is blocked when any simple command in it has a verb outside the read-only list below and meets one of two rules:

1. **It names a state file.** One of its words resolves to either file: `sed -i s/a/b/ .pi/workspaces/policy.json`, `truncate -s 0 .pi/workspaces/.registry.json`, `rsync /tmp/policy.json .pi/workspaces/policy.json`, `git checkout -- .pi/workspaces/policy.json`, `python3 tool.py --out=.pi/workspaces/policy.json`.
2. **It drops a same-named file into the directory.** One of its words resolves to the `<cwd>/.pi/workspaces` directory itself, and another word's last path segment is `policy.json` or `.registry.json`: `cp /tmp/policy.json .pi/workspaces/`, `mv /tmp/policy.json .pi/workspaces`, `install -t .pi/workspaces /tmp/.registry.json`, `cd .pi/workspaces && cp /tmp/policy.json .`.

The read-only list is exactly `cat`, `head`, `tail`, `wc`, `ls`, `stat`, `test`, `[`, `diff`, `cmp`, `jq`, and `grep`. The verb is the command name after leading `KEY=VALUE`, `sudo`, `env`, and `command`. Any other verb that names a state file is blocked, even when it would only read the file or pass its name to another machine (`ssh host rm .pi/workspaces/policy.json`), so `echo .pi/workspaces/policy.json | xargs truncate -s 0` is blocked at `echo`. A word resolves the way a write target does: read as bash reads it, against the working directory after `cd` and `pushd`, with symlinks followed, ignoring letter case. It resolves as itself and, when it contains `=`, also as the text after its first `=` (`--file=PATH`, `of=PATH`). For these two rules only, that text is also read with a leading `~` or `~/` as the home directory whatever precedes the `=`: bash passes `--out=~/f` on unchanged, and the program may expand the `~` itself. Either reading blocks. The rules apply to the same commands the write guard walks: subshells, pipelines, command substitutions, and heredocs read by a local shell.

Reading with a listed verb (`cat .pi/workspaces/policy.json > policy-copy.json`, `jq . .pi/workspaces/policy.json`, `ls -la .pi/workspaces`), work inside a workspace (`cp /tmp/policy.json .pi/workspaces/side/`, `rm -rf .pi/workspaces/side`), and a same-named file elsewhere (`sed -i s/a/b/ policy.json` in the project root) stay allowed without a prompt.

### Limits

The `write` and `edit` guards are exact: every call is checked against its canonicalized `path`. The `bash` guard is a best-effort heuristic over the fixed command list above, not a sandbox. It parses the command with [`unbash`](https://github.com/webpro-nl/unbash) and inspects every simple command, including those in `if`/`for`/`while`/`case` bodies, subshells, and command and process substitutions. It tracks `cd` (scoped to subshells and pipeline stages), skips leading `KEY=VALUE`, `sudo`, `env`, and `command`, expands only `~`, `$HOME`, and `${HOME}` where bash does, and ignores descriptor duplication (`2>&1`) and bash pseudo-devices (`/dev/null`, `/dev/stderr`, `/dev/fd/N`, `/dev/tcp/...`). Remote commands are not local writes: `ssh host mkdir /x`, quoted or escaped `>` (`ssh host echo hi \> /x`), and heredoc bodies (`ssh host <<EOF`, `cat > run.sh <<EOF`) are skipped; only the local side, such as `ssh host cmd > /x/log`, is checked. A heredoc or here-string is inspected as commands only when a local shell (`sh`, `bash`, `zsh`, `dash`, `ksh`) in the same pipeline reads it (`bash <<EOF`, `cat <<EOF | sh`); in a heredoc body with an unquoted delimiter, `$HOME` and `${HOME}` are expanded first, whatever quotes surround them there, as bash does. It does not run or evaluate the shell, so writes like these are not caught:

- interpreters and nested shells: `python -c "open('/x/f','w')"`, `node -e ...`, `bash -c "touch /x/f"`;
- in-place editors and unlisted writers: `sed -i`, `perl -i`, `rsync`, `curl -o`, `wget -O`, `find -delete`, `chmod`, `npm install -g`;
- shell expansion the guard does not model, which keeps its source text: variables other than `HOME` (`D=/x; touch $D/f`), `${HOME...}` forms with an operator, prefix, or index (`touch ${HOME:-/x}/f`), `~user` (`touch ~root/f`), `~+` and `~-`, a `~` after `+=` or a `:` (`X+=~/b`, `X=/a:~/b`), globs, brace lists (`touch {/x,a}/f`), quoted command substitution (`touch "$(dirname /x/a)/f"`), and backtick verbs;
- `\u` and `\U` escapes in `$'...'` on a bash older than 4.2, such as the macOS `/bin/bash`: the guard decodes them, and that bash keeps them as written (`touch $'a\u002fb/../../x/f'`);
- indirection and wrappers: `echo /x/f | xargs rm`, `nohup`/`timeout <cmd>`;
- a [guard state file](#guard-state-files) that no static word of the command names (a named one is blocked whatever the command, including the editors, unlisted writers, and `xargs` above): globs (`rm .pi/workspaces/*.json`), variables (`f=.pi/workspaces/policy.json; rm $f`), interpreters and nested shells (`python -c ...`, `bash -c ...`), and replacing or deleting a parent directory (`rm -rf .pi/workspaces`, `mv /tmp/ws .pi/workspaces`).

Other tools are not inspected.

## The `workspace` tool

The model can manage side workspaces directly with the `workspace` tool:

```ts
workspace({
  action: "create",
  name: "exp-parser",
  purpose: "test parser refactor on a clean worktree",
  ttlHours: 24
})
```

| Parameter | Accepts |
| --- | --- |
| `action` | `"create"`, `"list"`, `"pin"`, `"unpin"`, or `"release"`. |
| `name` | Required for `"create"`, `"pin"`, `"unpin"`, and `"release"`. Single directory name (1–120 characters, not starting with `.`, not `policy.json`, no path separators or `..`). |
| `purpose` | Optional short description (up to 500 characters) recorded with `"create"`. |
| `ttlHours` | Optional retention window in hours (`>= 0`) after the workspace is last accessed or its owning session closes. |

Metadata for each workspace is stored in `<cwd>/.pi/workspaces/.registry.json`, and projects that create workspaces are indexed in `<agentDir>/workspaces-index.json` so `/workspace gc --all` can find them across repositories.

## Safety states and garbage collection

Workspace inspection classifies each `<cwd>/.pi/workspaces/<name>` directory into one of four states before garbage collection:

| State | Meaning | GC behavior |
| --- | --- | --- |
| `PINNED` | Explicitly pinned via `/workspace pin <name>`, the `workspace` tool, or interactive GC review. | Always kept. |
| `ACTIVE` | Owned by a currently active session, a running process (`pid`), or still within its configured `ttlMs` retention window (and not explicitly `release`d). | Always kept. |
| `SAFE` | Empty directory, clean remote git clone with all commits pushed to a remote, or clean linked `git worktree` with no uncommitted/untracked files, no stashes, and no unmerged/unpushed commits. | Removed automatically by `/workspace gc`. |
| `REVIEW` | Contains non-git files, files outside nested git repositories, uncommitted or untracked changes, git stash entries, a local-only git repository with no remote, or unpushed/unmerged commits. | Kept by default; interactive `/workspace gc` prompts whether to `Keep for now`, `Pin permanently`, or `Remove anyway`. |

When removing a workspace that is a linked `git worktree`, garbage collection runs `git worktree remove --force` and `git worktree prune` against the main repository so Git's worktree metadata stays clean.

A symbolic link under `<cwd>/.pi/workspaces/` is not a workspace, whether it points outside the project, elsewhere inside it, or at another workspace. `/workspace list` and `/workspace gc` skip it, a registry entry for it is dropped, and garbage collection removes neither the link nor its target. Garbage collection removes only an entry directly under `<cwd>/.pi/workspaces/` that is not a symbolic link: a `path` in `.registry.json` cannot redirect it anywhere else, and `/workspace gc` fails with an error when a workspace turns into a link while its review prompt is open.

## `/workspace` subcommands

- `/workspace` or `/workspace list` — synchronize `<cwd>/.pi/workspaces/` with `.registry.json` and display each workspace's safety state (`PINNED`, `ACTIVE`, `SAFE`, `REVIEW`), reasons, byte size, purpose, and path, along with any allowed external paths.
- `/workspace gc [--dry-run | --yes | --all]` — garbage-collect workspaces:
  - `--dry-run` reports which workspaces would be removed or kept without deleting anything.
  - `--yes` skips interactive review prompts (removing `SAFE` workspaces and keeping `REVIEW`, `ACTIVE`, and `PINNED` workspaces).
  - `--all` runs garbage collection across every project closure listed in `<agentDir>/workspaces-index.json` and prunes entries whose project directories no longer exist.
- `/workspace allow <path>` — canonicalize `<path>` and add it to `<cwd>/.pi/workspaces/policy.json` and the current session allowlist. A directory allows everything under it.
- `/workspace deny <path>` — remove `<path>` from `<cwd>/.pi/workspaces/policy.json` and active session allowlists.
- `/workspace pin <name>` — mark workspace `<name>` as `PINNED`.
- `/workspace unpin <name>` — clear the `PINNED` flag on workspace `<name>`.

## Development

```sh
npm run test:workspace
npm run typecheck
```

The offline Vitest suite covers path canonicalization, symlink escape detection, bash write target extraction, `.pi/workspaces` closure and registry persistence, `PINNED` / `ACTIVE` / `SAFE` / `REVIEW` safety classification, linked `git worktree` cleanup, symlinked `.pi/workspaces/<name>` entries that garbage collection must not follow, and real Pi session runs on the faux provider.
