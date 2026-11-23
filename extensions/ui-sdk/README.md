# UI SDK

Ships the `ui-sdk` agent skill from Vercel's [UI SDK](https://ui-sdk.dev) (beta) to Pi as an explicit-only `/skill:ui-sdk` static skill. UI SDK is a headless behavior library, `@ui-sdk/core` plus the adapters `@ui-sdk/react`, `@ui-sdk/vue`, `@ui-sdk/svelte`, `@ui-sdk/solid` and `@ui-sdk/web`. It handles focus, keyboard, selection, popups, drag and drop and ARIA, and renders no styles. The skill tells the agent how to compose its components, build missing ones from `@ui-sdk/core`, make interfaces agent-ready, and test them.

`skills/ui-sdk/` is an unmodified copy of upstream `packages/core/skills/ui-sdk/` at `@ui-sdk/core` 0.1.0-beta.2 (`upstream.json` has the commit and file hashes).

## Explicit `/skill:ui-sdk` loading

The collection registers `./extensions/ui-sdk/entry` in `package.json` `pi.skills` (keeping `skills/ui-sdk/` unmodified and out of `pi.skills`). The wrapper skill at `entry/ui-sdk/SKILL.md` sets `disable-model-invocation: true`, so `ui-sdk` stays out of `<available_skills>` and never steers ordinary UI work unless you explicitly invoke `/skill:ui-sdk`.

When invoked, `/skill:ui-sdk` directs the agent to read the project's `node_modules/@ui-sdk/core/skills/ui-sdk/SKILL.md` first if present (matching the installed version), and otherwise fall back to this package's vendored `skills/ui-sdk/SKILL.md`. It also instructs the agent never to install `@ui-sdk/*` packages without asking first.

## Use it in a project

```bash
npm install @ui-sdk/react @ui-sdk/core   # React adapter needs react and react-dom >=19
```

Then invoke the skill explicitly in a prompt, for example:

```text
/skill:ui-sdk build a five-star rating in React with ui-sdk, keyboard accessible, with tests
```

The skill sends the agent to the docs for the installed version (`node_modules/@ui-sdk/<framework>/docs/llms.txt`), not to its own copy or the website.

## Styling

UI SDK supplies behavior and ARIA and renders no styles. Style UI SDK parts with your project's design tokens by targeting `[data-slot=...]` and state attributes such as `[data-open]` or `[data-pressed]`, plus the CSS variables each component lists. If the app uses `@ui-sdk/core/web.css`, map your design tokens onto its `--ui-*` tokens on `:root` instead of overriding it with `!important`.

## Upgrade

1. `git clone https://github.com/vercel-labs/ui /tmp/vercel-ui`, then check out the latest `@ui-sdk/core@<version>` tag (`git tag -l '@ui-sdk/core@*'`).
2. Replace `skills/ui-sdk/` with `packages/core/skills/ui-sdk/` and copy `LICENSE`. Don't edit the copied files.
3. Update `upstream.json` (`tag`, `commit`, `version`, and every hash from `shasum -a 256`) and the version in `NOTICE.md` and this README.
4. Run `npm run test:ui-sdk`.
