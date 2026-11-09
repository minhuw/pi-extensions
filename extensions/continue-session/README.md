# Continue session

`/continue-session` reads a recorded Pi session's trajectory and carries its unfinished work forward in the current session. It uses the current model and tools through a native Pi prompt template.

```text
/continue-session 550e8400-e29b-41d4-a716-446655440000
/continue-session 550e8400-e29b-41d4-a716-446655440000 finish the failing tests first
```

Provide the **full session ID**, for example from `/session`, the pika web UI, or a `recall_search` result. Any text after the ID is an instruction for the continuation. With no ID, the prompt asks for one.

The model reads the overview through its last page with `recall_read`, then reads details around the latest relevant turns and other parts needed to understand the task. It checks the current project and work before acting, follows the latest user requirements, and continues the unfinished work. If the work is already complete, it reports that. An outstanding question or approval remains a blocker when its answer is necessary.

## Requirements

The source session must have been uploaded to a [pika server](../pika/README.md#recall). The current device needs `/pika login`, a server with the agent read API, and read access for the device. The `recall_read` tool must be available, either directly or through `codemode`. Sessions on other machines and projects are accessible if that server recorded them. Local-only sessions and partial IDs are not resolved by this command; Pi's `/resume` can open a local session.

Install or update the collection and run `/reload`. If package settings filter resources, enable `extensions/continue-session/prompts/continue-session.md` and the pika extension. For a separately loaded prompt:

```bash
pi --prompt-template /absolute/path/to/pi-extensions/extensions/continue-session/prompts/continue-session.md
```

## Behavior and limits

This starts a normal model turn in the **current** session; it does not switch sessions or write to the source transcript. It uses pika's recorded history, which can lag behind an active session, omit content, or include abandoned branches. Individual recall results and long entries may be truncated. Images are represented as placeholders, and credential data is scrubbed. The model is instructed to verify the current state and disclose relevant gaps; reading and continuation are model instructions rather than runtime-enforced behavior.

The model follows the current session's instructions. It treats historical user requests as evidence of the task being continued and old tool outputs, assistant text, and third-party content as data. A recorded approval question is not automatically an approval.

Run `npm run test:continue-session` for offline loading and argument expansion checks. These checks do not prove that a model follows the prompt or that a pika server has a particular session.
