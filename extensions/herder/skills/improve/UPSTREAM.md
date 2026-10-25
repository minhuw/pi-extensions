# Upstream provenance

This skill is derived from [shadcn/improve](https://github.com/shadcn/improve) at commit `03369ee6d7cafbfcecc4346539b05b3dc0a603bb`, imported on 2026-07-15.

The upstream work is Copyright (c) 2026 shadcn and licensed under the MIT License. See `LICENSE.md` in this directory.

Herder-specific modifications:

- package Improve as the read-only `herder-improve` audit skill, started by `/herder-improve`;
- present only vetted findings with verified repository evidence, a compact table, and an individual explanation of every finding;
- let the user pick findings with `herder_pick_findings` (or take the recommended ones with `--auto`), then start a Herder run for them with `herder_run { action: "start" }`;
- turn the selected findings into the run's approved goal, with one acceptance criterion per finding mapped to repository checks, and its plan;
- leave implementation, verification, and delivery to the Herder run instead of maintaining a second executor;
- keep findings that need product intent out of the selection and point the user to `/herder <goal>`;
- remove upstream command variants that write plans or execute them; and
- normalize skill metadata for packaged discovery.
