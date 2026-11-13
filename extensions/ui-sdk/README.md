# UI SDK

Ships the `ui-sdk` agent skill from Vercel's [UI SDK](https://ui-sdk.dev) (beta) to Pi. UI SDK is a headless behavior library, `@ui-sdk/core` plus the adapters `@ui-sdk/react`, `@ui-sdk/vue`, `@ui-sdk/svelte`, `@ui-sdk/solid` and `@ui-sdk/web`. It handles focus, keyboard, selection, popups, drag and drop and ARIA, and renders no styles. The skill tells the agent how to compose its components, build missing ones from `@ui-sdk/core`, make interfaces agent-ready, and test them.

`skills/ui-sdk/` is an unmodified copy of upstream `packages/core/skills/ui-sdk/` at `@ui-sdk/core` 0.1.0-beta.2 (`upstream.json` has the commit and file hashes). The collection lists it in `pi.skills`. The skill is model-invocable, and the description makes it load when a project has `@ui-sdk/*` installed or the user mentions ui-sdk. `/skill:ui-sdk` forces it.

## Use it in a project

```bash
npm install @ui-sdk/react @ui-sdk/core   # React adapter needs react and react-dom >=19
```

Then prompt, for example:

```text
Use ui-sdk to build a five-star rating in React, keyboard accessible, with tests.
```

The skill sends the agent to the docs for the installed version (`node_modules/@ui-sdk/<framework>/docs/llms.txt`), not to its own copy or the website.

## The installed copy wins

`@ui-sdk/core` publishes the same skill at `node_modules/@ui-sdk/core/skills/ui-sdk/`, matched to the installed version. This vendored copy can be older or newer. To make Pi load the project's copy, add it to the project's `.pi/settings.json` (paths resolve from `.pi/`):

```json
{ "skills": ["../node_modules/@ui-sdk/core/skills"] }
```

Pi ranks project settings entries above package resources and keeps the first skill per name, so the installed `ui-sdk` loads and Pi warns about a `ui-sdk` name collision. The warning is expected. `tests/ui-sdk.test.ts` checks this precedence.

## With Impeccable

Impeccable decides the visual design and the `DESIGN.md` tokens; UI SDK supplies behavior and ARIA. Style UI SDK parts from Impeccable's tokens by targeting `[data-slot=...]` and state attributes such as `[data-open]` or `[data-pressed]`, plus the CSS variables each component lists. If the app uses `@ui-sdk/core/web.css`, map the design tokens onto its `--ui-*` tokens on `:root` instead of overriding it with `!important`.

## Upgrade

1. `git clone https://github.com/vercel-labs/ui /tmp/vercel-ui`, then check out the latest `@ui-sdk/core@<version>` tag (`git tag -l '@ui-sdk/core@*'`).
2. Replace `skills/ui-sdk/` with `packages/core/skills/ui-sdk/` and copy `LICENSE`. Don't edit the copied files.
3. Update `upstream.json` (`tag`, `commit`, `version`, and every hash from `shasum -a 256`) and the version in `NOTICE.md` and this README.
4. Run `npm run test:ui-sdk`.
