# Closing the Loop in Herder

Improve produces and maintains plans from repository findings. Grill produces plans from confirmed user intent. Herder Plans owns their shared format and lifecycle state. Herder Fire owns execution. Do not recreate Improve's upstream one-off executor inside this skill.

## `execute [<plan>]` — hand off to Fire

1. Resolve the Herder extension root and validate the backlog:

   ```bash
   Call `herder_plan` with `operation: "validate"` for the plan directory.
   ```

2. If validation fails, repair only the plan backlog and validate again.
3. Tell the user that Herder executes the dependency graph, including prerequisites, rather than an isolated plan with hidden dependency state.
4. Apply `/herder-fire herder-plans` in Pi. If the session cannot switch workflows in the same turn, return that exact invocation instead.

The optional plan argument is a compatibility hint, not a request to bypass the graph. Confirm the named plan exists and explain which unfinished prerequisites Fire will execute first.

## `reconcile` — keep `herder-plans/` current

Run Plans status, then inspect every plan file:

```bash
Call `herder_plan` with `operation: "status"` for the plan directory.
```

Handle each status:

- **DONE** — verify its cheap done criteria still hold on current HEAD. If they fail, transition it to `BLOCKED` with a concise regression reason and refresh the plan.
- **BLOCKED** — investigate the recorded obstacle. Rewrite around it when evidence permits; otherwise keep the blocker precise or mark it `REJECTED` with rationale.
- **IN PROGRESS** — compare Fire's namespaced integration branch with the plan's single stable branch. Do not assume a dead agent; leave execution recovery to Fire.
- **TODO** — run its drift check. Refresh current-state excerpts and `Planned at` when drifted. Mark `REJECTED` when the finding was fixed independently.
- **REJECTED** — retain the file and rationale as audit history unless the user intentionally reopens it.

Use the Plans manager for every status transition. After content changes, run `validate` again. Finish with a short report of verified, refreshed, rejected, blocked, and currently ready plans.

## `--issues` — publish plans as GitHub issues

The flag is explicit authorization to create issues; never create them without it.

1. Check `gh auth status` and confirm the repository has a GitHub remote. If either fails, keep the local plans and report why publishing was skipped.
2. Check `gh repo view --json visibility`. For a public repository, get explicit confirmation before publishing any plan that describes a security vulnerability, credential location, or other sensitive finding.
3. Show the titles about to become issues and confirm once when interactive.
4. Create each issue with `gh issue create --title "<title>" --body-file <plan-file>`. Apply `improve` and category labels only when they already exist or can be created without disrupting the workflow.
5. Record each issue URL in the plan Status block and index, then validate the backlog.

The plan file remains the source of truth; the issue is only a distribution copy.
