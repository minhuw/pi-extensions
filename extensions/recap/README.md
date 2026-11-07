# Recap

`/recap` summarizes the current session so you can pick up after a break. This native Pi prompt template uses the current model and the conversation already in context.

```text
/recap
/recap focus on the test failures
/recap since the last recap
/recap since yesterday
```

The response starts with the session's goal, then gives up to four short bullets: recent progress, a key decision, where work stopped, and the next step. It aims for fewer than 200 words. Completed tasks are described as complete; suggestions and unverified work are labeled.

The prompt asks the model to summarize and stop, without calling tools or resuming the task. It draws on the conversation, including available compaction and branch summaries. File state, test results, and background jobs are described as last observed; the recap is not a fresh status check. If the requested range needs context or timestamps that are missing, the response says so. An empty session gets a short "nothing to recap yet" response.

Arguments narrow the topic or time range through Pi's native `$ARGUMENTS` expansion. They are natural-language instructions, with no flags or date parser. Asking for "since the last recap" emphasizes substantive changes since the last recap visible in context.

## Installation

If this collection is installed from your local checkout, run `/reload`. If installed from Git, update the package and then run `/reload`. The package registers `extensions/recap/prompts/recap.md`; enable that resource if your package settings filter prompts.

For standalone use:

```bash
pi --prompt-template /absolute/path/to/pi-extensions/extensions/recap/prompts/recap.md
```

Remove any conflicting `/recap` prompt or extension command. This command is separate from Writer's `/summary`, which summarizes academic text.

## Behavior and limits

This is a normal model turn: its prompt and response become part of the conversation and use the session's model and thinking settings. It adds no runtime extension, separate model configuration, inactivity detector, or persistent recap state. It does not deliberately compact or replace history; Pi's normal context management still applies.

The output format and no-tool behavior are instructions to the model, not runtime enforcement. Loading and expansion checks establish that Pi discovers and expands the template; they do not establish that every model follows its instructions. Details no longer present in context cannot be recovered by this prompt.

## Inspiration

These sources informed this independently written prompt:

- [Claude Code's session recap](https://code.claude.com/docs/en/interactive-mode#session-recap): `/recap` provides an on-demand orientation after time away. Its documented 400-character limit favors quick scanning; this prompt allows a few bullets to retain blockers and next steps.
- [Qwen Code's session recap](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/commands.md#18-session-recap-recap): emphasizes recent conversation and where work left off. Qwen uses a separate model request over recent text messages; this template uses the current session context, including existing tool results as evidence.
- [Florian Bruniaux's community `/catchup`](https://github.com/FlorianBruniaux/claude-code-ultimate-guide/blob/main/examples/skills/catchup/SKILL.md): organizes recent work, outstanding issues, and suggested next steps. That command reconstructs project state from Git; `/recap` gets its evidence from this conversation.
- [Pi's conversation summary example](https://github.com/earendil-works/pi-coding-agent/blob/main/examples/extensions/summarize.ts): includes goals, key decisions, progress, open questions, and next steps. A native prompt is enough here because the current model already has the context needed for a short recap.
