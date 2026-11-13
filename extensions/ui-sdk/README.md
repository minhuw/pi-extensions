# UI SDK

Ships the `ui-sdk` agent skill from Vercel's [UI SDK](https://ui-sdk.dev) (beta) to Pi. UI SDK is a headless behavior library, `@ui-sdk/core` plus the adapters `@ui-sdk/react`, `@ui-sdk/vue`, `@ui-sdk/svelte`, `@ui-sdk/solid` and `@ui-sdk/web`. It handles focus, keyboard, selection, popups, drag and drop and ARIA, and renders no styles. The skill tells the agent how to compose its components, build missing ones from `@ui-sdk/core`, make interfaces agent-ready, and test them.

`skills/ui-sdk/` is an unmodified copy of upstream `packages/core/skills/ui-sdk/` at `@ui-sdk/core` 0.1.0-beta.2 (`upstream.json` has the commit and file hashes).

## Loaded only with Impeccable

The collection keeps the skill out of `pi.skills`, so `ui-sdk` is never in `<available_skills>` and ordinary UI work doesn't pick it up. Instead `index.ts` publishes it as a design companion on `Symbol.for("pi-extensions.design-companions")`. When a prompt activates [Impeccable](../impeccable/README.md) (`/impeccable`, `/design-*`, a mention of `impeccable`, ...), Impeccable adds a hidden line once per compaction window:

```text
Companion skill ui-sdk (headless behaviors for interactive web components: focus, keyboard, popups, selection, drag and drop, ARIA): when the work needs it, read the project's node_modules/@ui-sdk/core/skills/ui-sdk/SKILL.md if present (matches the installed version), else <this package>/extensions/ui-sdk/skills/ui-sdk/SKILL.md. If the project lacks it, you may propose adding it; never install it unasked.
```

`@ui-sdk/core` publishes the same skill at `node_modules/@ui-sdk/core/skills/ui-sdk/`, matched to the installed version, so the line sends the agent there first; this vendored copy can be older or newer. Without Impeccable, read the skill directly (`read extensions/ui-sdk/skills/ui-sdk/SKILL.md`).

## Use it in a project

```bash
npm install @ui-sdk/react @ui-sdk/core   # React adapter needs react and react-dom >=19
```

Then prompt through Impeccable, for example:

```text
/design-craft a five-star rating in React with ui-sdk, keyboard accessible, with tests
```

The skill sends the agent to the docs for the installed version (`node_modules/@ui-sdk/<framework>/docs/llms.txt`), not to its own copy or the website.

## Styling with Impeccable

Impeccable decides the visual design and the `DESIGN.md` tokens; UI SDK supplies behavior and ARIA. Style UI SDK parts from Impeccable's tokens by targeting `[data-slot=...]` and state attributes such as `[data-open]` or `[data-pressed]`, plus the CSS variables each component lists. If the app uses `@ui-sdk/core/web.css`, map the design tokens onto its `--ui-*` tokens on `:root` instead of overriding it with `!important`.

## Upgrade

1. `git clone https://github.com/vercel-labs/ui /tmp/vercel-ui`, then check out the latest `@ui-sdk/core@<version>` tag (`git tag -l '@ui-sdk/core@*'`).
2. Replace `skills/ui-sdk/` with `packages/core/skills/ui-sdk/` and copy `LICENSE`. Don't edit the copied files.
3. Update `upstream.json` (`tag`, `commit`, `version`, and every hash from `shasum -a 256`) and the version in `NOTICE.md` and this README.
4. Run `npm run test:ui-sdk`.
