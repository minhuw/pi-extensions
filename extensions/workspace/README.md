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

- `~` and `$HOME` are expanded.
- Symlinks are resolved through the deepest existing ancestor on disk, so a symlink inside `<cwd>` that points outside `<cwd>` is evaluated by its real external target.
- Writes inside `<cwd>` (including `<cwd>/.pi/workspaces/<name>`), the repository's git common directory, `/tmp` (and `os.tmpdir()`), and paths in the session or project allowlist succeed without prompting.

When a tool call targets an unapproved path outside `<cwd>` and `/tmp`:

- **Interactive top-level sessions (`hasUI: true`):** Pi prompts with `ctx.ui.select`:
  - `Allow once` — permits this single tool call only.
  - `Allow for this session` — permits the path (and its parent directory for file writes) for the rest of the current session and any child sessions it spawns.
  - `Allow for this project` — records the canonical path in `<cwd>/.pi/workspaces/policy.json` (`allowedPaths`) and permits it across sessions for this project.
  - `Deny` — blocks the tool call and directs the model to `<cwd>/.pi/workspaces/<name>` or `/tmp`.
- **Child sessions and non-interactive sessions (`print`, `json`):** While any top-level session is open, the extension registers itself in `globalThis[Symbol.for("pi-extensions.child-session-hooks")]` and removes the hook when all sessions shut down. Child sessions (including sessions carrying a `pi-extensions.session-link` entry) inherit the active session and project allowlists, and immediately block unapproved external writes without prompting.

### Limits

The `write` and `edit` guards are exact: every call is checked against its canonicalized `path`. The `bash` guard is a best-effort heuristic over the fixed command list above, not a sandbox. It parses the command with [`unbash`](https://github.com/webpro-nl/unbash) and inspects every simple command, including those in `if`/`for`/`while`/`case` bodies, subshells, and command and process substitutions. It tracks `cd` (scoped to subshells and pipeline stages), skips leading `KEY=VALUE`, `sudo`, `env`, and `command`, expands only `~`, `$HOME`, and `${HOME}`, and ignores descriptor duplication (`2>&1`) and bash pseudo-devices (`/dev/null`, `/dev/stderr`, `/dev/fd/N`, `/dev/tcp/...`). Remote commands are not local writes: `ssh host mkdir /x`, quoted or escaped `>` (`ssh host echo hi \> /x`), and heredoc bodies (`ssh host <<EOF`, `cat > run.sh <<EOF`) are skipped; only the local side, such as `ssh host cmd > /x/log`, is checked. A heredoc or here-string is inspected as commands only when a local shell (`sh`, `bash`, `zsh`, `dash`, `ksh`) in the same pipeline reads it (`bash <<EOF`, `cat <<EOF | sh`). It does not run or evaluate the shell, so writes like these are not caught:

- interpreters and nested shells: `python -c "open('/x/f','w')"`, `node -e ...`, `bash -c "touch /x/f"`;
- in-place editors and unlisted writers: `sed -i`, `perl -i`, `rsync`, `curl -o`, `wget -O`, `find -delete`, `chmod`, `npm install -g`;
- shell expansion: variables (`D=/x; touch $D/f`), quoted command substitution (`touch "$(dirname /x/a)/f"`), and backtick verbs;
- indirection and wrappers: `echo /x/f | xargs rm`, `nohup`/`timeout <cmd>`.

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

## `/workspace` subcommands

- `/workspace` or `/workspace list` — synchronize `<cwd>/.pi/workspaces/` with `.registry.json` and display each workspace's safety state (`PINNED`, `ACTIVE`, `SAFE`, `REVIEW`), reasons, byte size, purpose, and path, along with any allowed external paths.
- `/workspace gc [--dry-run | --yes | --all]` — garbage-collect workspaces:
  - `--dry-run` reports which workspaces would be removed or kept without deleting anything.
  - `--yes` skips interactive review prompts (removing `SAFE` workspaces and keeping `REVIEW`, `ACTIVE`, and `PINNED` workspaces).
  - `--all` runs garbage collection across every project closure listed in `<agentDir>/workspaces-index.json` and prunes entries whose project directories no longer exist.
- `/workspace allow <path>` — canonicalize `<path>` and add it to `<cwd>/.pi/workspaces/policy.json` and the current session allowlist.
- `/workspace deny <path>` — remove `<path>` from `<cwd>/.pi/workspaces/policy.json` and active session allowlists.
- `/workspace pin <name>` — mark workspace `<name>` as `PINNED`.
- `/workspace unpin <name>` — clear the `PINNED` flag on workspace `<name>`.

## Development

```sh
npm run test:workspace
npm run typecheck
```

The offline Vitest suite covers path canonicalization, symlink escape detection, bash write target extraction, `.pi/workspaces` closure and registry persistence, `PINNED` / `ACTIVE` / `SAFE` / `REVIEW` safety classification, linked `git worktree` cleanup, and real Pi session runs on the faux provider.
