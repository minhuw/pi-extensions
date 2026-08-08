# Upstream provenance

This skill is derived from [shadcn/improve](https://github.com/shadcn/improve) at commit `03369ee6d7cafbfcecc4346539b05b3dc0a603bb`, imported on 2026-07-15.

The upstream work is Copyright (c) 2026 shadcn and licensed under the MIT License. See `LICENSE.md` in this directory.

Herder-specific modifications:

- package Improve as a Herder planning skill;
- produce plans only from verified repository findings and route user-defined new features to Grill;
- write plans to `herder-plans/` through the shared Herder Plans protocol and template;
- validate generated plans with the Herder plan manager;
- delegate execution to Herder Fire instead of maintaining a second scheduler;
- adapt reconciliation and status ownership to Herder Plans; and
- normalize skill metadata for packaged discovery.
