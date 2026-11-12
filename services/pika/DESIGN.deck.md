---
name: Deck
description: Deck's own design system, for /deck/* (terminals, files and agents on the owner's nodes); applies to web/src/pages/Deck.tsx and web/src/nodes/**, scoped under the [data-deck] root. Excludes /docs/* (DESIGN.md) and the rest of the pika dashboard.
colors:
  dk-ground: "#fcfcfd"
  dk-chrome: "#f1f3f5"
  dk-line: "#dde1e6"
  dk-line-strong: "#c3c9d0"
  dk-code: "#eceff2"
  dk-raised: "#ffffff"
  dk-tip: "#23282e"
  dk-tip-ink: "#f1f3f5"
  dk-ink: "#161a1f"
  dk-ink-2: "#4f5863"
  dk-ink-3: "#626a74"
  dk-accent: "#5a46c8"
  dk-on-accent: "#ffffff"
  dk-needs: "#b25e00"
  dk-needs-ink: "#8f4b00"
  dk-failed: "#c4321f"
  dk-failed-ink: "#b02a19"
  dk-done: "#1d8a4a"
  dk-done-ink: "#16703b"
  dk-working: "#2b71b8"
  dk-working-ink: "#22609e"
  dk-dark-ground: "#111417"
  dk-dark-chrome: "#171a1e"
  dk-dark-line: "#262b31"
  dk-dark-line-strong: "#383f47"
  dk-dark-code: "#1d2126"
  dk-dark-raised: "#1f2328"
  dk-dark-tip: "#e4e7eb"
  dk-dark-tip-ink: "#111417"
  dk-dark-ink: "#e4e7eb"
  dk-dark-ink-2: "#a6aeb8"
  dk-dark-ink-3: "#8a929c"
  dk-dark-accent: "#a596ff"
  dk-dark-on-accent: "#111417"
  dk-dark-needs: "#f2a33a"
  dk-dark-failed: "#ff7a6b"
  dk-dark-done: "#4fc47f"
  dk-dark-working: "#6cb0ea"
typography:
  dk-ui:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  dk-row-title:
    fontFamily: "{typography.dk-ui.fontFamily}"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.45
  dk-section-label:
    fontFamily: "{typography.dk-ui.fontFamily}"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.45
  dk-meta:
    fontFamily: "{typography.dk-ui.fontFamily}"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.45
  dk-mono:
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.2
rounded:
  dk-small: "2px"
  dk-control: "3px"
  dk-bar-control: "4px"
  dk-menu: "6px"
  dk-dialog: "8px"
spacing:
  dk-1: "4px"
  dk-2: "8px"
  dk-3: "12px"
  dk-row-y: "5px"
  dk-child-indent: "18px"
components:
  dk-rail-row:
    textColor: "{colors.dk-ink}"
    typography: "{typography.dk-row-title}"
    padding: "5px 12px"
  dk-section-header:
    textColor: "{colors.dk-ink-2}"
    typography: "{typography.dk-section-label}"
    height: "28px"
  dk-row-action:
    backgroundColor: "{colors.dk-chrome}"
    textColor: "{colors.dk-ink-2}"
    rounded: "{rounded.dk-control}"
    size: "22px"
  dk-view-toggle:
    textColor: "{colors.dk-ink-2}"
    rounded: "{rounded.dk-control}"
    height: "24px"
  dk-tab-active:
    backgroundColor: "{colors.dk-ground}"
    textColor: "{colors.dk-ink}"
  dk-app-bar:
    backgroundColor: "{colors.dk-chrome}"
    height: "40px"
  dk-status-bar:
    backgroundColor: "{colors.dk-chrome}"
    textColor: "{colors.dk-ink-2}"
    typography: "{typography.dk-meta}"
    height: "24px"
  dk-bar-button:
    textColor: "{colors.dk-ink-2}"
    rounded: "{rounded.dk-bar-control}"
    size: "28px"
  dk-menu:
    backgroundColor: "{colors.dk-raised}"
    rounded: "{rounded.dk-menu}"
    padding: "4px"
  dk-menu-item:
    height: "24px"
    rounded: "{rounded.dk-bar-control}"
  dk-tooltip:
    backgroundColor: "{colors.dk-tip}"
    textColor: "{colors.dk-tip-ink}"
    rounded: "{rounded.dk-bar-control}"
---

# Design System: Deck

## Overview

**Creative North Star: "The work is the ground; only status speaks in colour."**

Deck (`/deck/*`) is the owner's agents on every node, in one rail sorted by what they need, beside split tab groups of terminals, files and diffs, with the Explorer and Changes on the right. It is an Operate surface used for hours at a time, next to a real editor and terminal, in both themes, and it should feel like a desktop app (Zed, VS Code, Orca) rather than a web page: it fills the window with its own frame, and its chrome behaves like native chrome. It takes the density and calm of an IDE, one accent for "where you are", and four status colours that mean exactly one thing each.

It is scoped. `services/pika/DESIGN.md` (Swiss Typographic Concordance) owns `/docs/*`; the rest of the pika dashboard keeps its monochrome identity, where red is the only colour. Nothing here applies outside the Deck root, and nothing from those systems applies inside it except the shared `Icon` set and the shared buttons, which the root re-tones.

**Name in one place.** The name "Deck" lives in `web/src/nodes/deck/tokens.ts` (`DECK`), the token prefix is `--dk-` in `web/src/nodes/deck/deck.css`, and the root attribute is `data-deck` (`DECK_ROOT`). The route is `/deck` and the dashboard band's tab says "Deck"; "node" stays the word for a machine.

**Key characteristics**

- Cool neutral grounds: the work (terminal, editor, active tab) on the lightest ground, chrome (rail, Explorer, tab strips) one step down. No shadows for structure; one-pixel lines.
- One accent, an indigo violet (`dk-accent`), for selection, focus, the active tab and group, splitter focus and drop targets, the terminal's selection and search, and Monaco's cursor. It never marks a status.
- Status colours, reserved: needs you amber, failed red, done green, working blue; idle and quiet are ink. Every status also has its own glyph shape, so colour is never the only cue.
- The system UI face at 13px, 11.5px metadata, tabular numerals; monospace only for terminals, code, and the browser key.

## Colors

Restrained strategy: tinted neutrals plus one accent; colour does the status job and nothing else.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Ground `dk-ground` | `#fcfcfd` | `#111417` | Terminal and editor background, active tab, page |
| Chrome `dk-chrome` | `#f1f3f5` | `#171a1e` | Rail, Explorer, tab strips, row-action chips |
| Line `dk-line` / `dk-line-strong` | `#dde1e6` / `#c3c9d0` | `#262b31` / `#383f47` | Hairlines; strong for control frames and splitter hover |
| Ink `dk-ink` / `dk-ink-2` / `dk-ink-3` | `#161a1f` / `#4f5863` / `#626a74` | `#e4e7eb` / `#a6aeb8` / `#8a929c` | Text; secondary; receded (quiet rows, times, `project · node`) |
| Accent `dk-accent` | `#5a46c8` | `#a596ff` | Location and focus only; `dk-accent-soft` (11% / 15%) for the selected row and project |
| Needs you | glyph `#b25e00`, text `#8f4b00` | `#f2a33a` | Waiting dialogs, questions, logins; "Needs you" header when non-empty |
| Failed | glyph `#c4321f`, text `#b02a19` | `#ff7a6b` | pi's error status, a nonzero exit, a node that needs attention |
| Done | glyph `#1d8a4a`, text `#16703b` | `#4fc47f` | Finished since last seen; the unread dot |
| Working | glyph `#2b71b8`, text `#22609e` | `#6cb0ea` | The working ring and header badge |

Contrast, measured against ground and chrome: ink 17.0 / 15.7, ink-2 7.0 / 6.5, ink-3 5.3 / 4.9, accent 6.5 / 6.0, the `-ink` status tones ≥ 5.5 in light; in dark every text token is ≥ 5.5 on both grounds. White on the light accent is 6.7:1, ground on the dark accent 7.4:1.

Inside the root the shared names (`--color-page`, `--color-sidebar`, `--color-ink`, `--color-muted`, `--color-line`, `--color-hover`, `--color-red`, …) are pointed at Deck tokens, so the page's existing classes take this palette; new code uses the `dk-` utilities (`text-dk-needs-ink`, `bg-dk-accent-soft`, …). Text selection is `dk-accent-soft`; focus rings are `dk-accent`; scrollbars are ink at 22%.

The terminal and Monaco take the same values as literals from `DK_TOKENS` (`tokens.ts`); `tests/node-rail.test.tsx` fails if they drift from the CSS. Terminal selection is the accent over ground at 20% (light) / 30% (dark); search matches at 22%, the active match at 50%. Monaco adds the accent cursor and focus border, the chrome as current-line highlight, and line numbers at ink-2 over ground at 70%.

**Named rule — Status Is Reserved.** Amber, red, green and blue appear only on a status glyph, a status label, the attention line under a row, or a count of those. A control, a selection, a link, or decoration never uses them. The accent never means a status.

## Typography

One family: the platform UI face (`system-ui`, SF on macOS), because this page sits beside the user's own editor and terminal and should read like them. Aileron, the dashboard's face, stays outside the root.

| Role | Size / weight | Where |
| --- | --- | --- |
| UI | 13px / 400, line-height 1.45 | Base inside the root |
| Row title | 13px / 500; 600 when unread or selected; 400 in ink-3 when quiet | Agent rows, project cards |
| Section label | 12px / 600, ink-2, sentence case | Needs you, Failed, Done, Working, Quiet |
| Meta | 11.5px / 400, ink-3, tabular numerals | `project · node`, times, counts, attention line |
| Mono | 13px | xterm, Monaco, the browser key |

No uppercase tracking, no eyebrow labels. Times and counts are `tabular-nums` so ticking values do not jitter.

## Density and layout

- App bar 40px, status bar 24px; panel headers (rail, workspace breadcrumb, Explorer/Changes switch) and tab strips 36px, so their bottom lines meet; controls in the bars 28px.
- Rail 280px by default, 220–500 resizable; Explorer 300px. Rail header 36px; section headers 28px; agent rows two lines (title, then `project · node` or the attention text) at 5px vertical padding, about 40px; activity rows 24px, indented 18px from their agent's text.
- Spacing steps of 4px; rows use 12px side padding (32px for agents inside a Projects card).
- Rows draw with `content-visibility: auto` (`contain-intrinsic-size: auto 40px`), so a long rail lays out only what is on screen.
- Radius 2–3px on controls only; rows, sections, tab strips and panels are square.

## The rail

### Status view (the default): the inbox

One list for every agent on every node, in sections by what the user has to do (`web/src/nodes/workspace/inbox.ts`):

| Section | An agent is here when | Right slot | Second line |
| --- | --- | --- | --- |
| Needs you | Merged state `waiting`: OSC 7501 `blocked`, the bridge waiting, or a waiting activity | Kind (Permission / Question / Login) in needs ink, then age | The dialog's message, or "<activity> is waiting" |
| Failed | pi's program status `error`, or exited with a nonzero code | Age | The error message, or "Exited with code N" |
| Done | Idle and unread (finished since last seen) | Age; title semibold with a green dot | `project · node` |
| Working | Busy (pi's turn or background activities) | Ticking elapsed time, `2m14s` | `project · node`, or "No update in 34m" when stale |
| Quiet | Idle and seen, or ended by itself (exit 0 or a signal) | Age, or "Exited" | `project · node` |

- **Order:** within a section, newest return to the user first (T3 Code's `sortInboxThreadsByReturn`); Working keeps terminal creation order so it does not shuffle as agents take turns.
- **Exit grace:** an agent that stops working stays in Working for 2 s (T3's `WORKING_EXIT_GRACE_MS`), so pi idling between a turn and its retry, compaction or queued message does not flicker it out. Needing the user, failing, or exiting show at once.
- **Pointer hold:** while the pointer is over the list, rows keep their places (a changed glyph still updates); they move when it leaves.
- **Selection hold:** an agent the user opens from Done stays in Done, marked seen, until they move to another agent.
- **Staleness:** a Working agent whose status has not changed for 30 min shows a dashed still ring and "No update in …" (Orca's freshness rule).
- **Sections:** header with chevron, label and count; empty sections hide, except Needs you, which says "Nothing needs you". Quiet starts folded; folding is remembered (`pika.nodes.rail`).
- **Row:** status glyph, label (pi session name, else terminal title, else program, else "Shell"), right status slot, second line. Click: switch to the agent's project, activate its tab, focus its pane, mark it seen.
- **Hover actions** replace the status slot in place, without moving anything: Close pane (only when the agent has a pane in a workspace), and Kill, or Remove for an exited terminal. They also show on keyboard focus.
- **Background activities** (subagents, Herder steps, from a live bridge) list under their agent, waiting first, up to four, with progress and elapsed time, then "N more"; clicking one opens the agent.
- **Nodes:** a compact strip at the top lists every node with its link state; it is the way to a node with no agents and to pairing. Rows of a node that is not connected show at 60% opacity with the state on the row (Orca's disconnected host). Chosen over a per-row marker only because a node with no agents would otherwise be unreachable from the rail.

### Projects view

The toggle in the rail header switches to node → project cards (the earlier layout). Node headers carry the link glyph and state; cards fold, and a folded card shows its strongest status glyph and agent count (T3's aggregated dot). Agents within a card keep the inbox's order.

### Keyboard

Arrow keys move between rows without opening them, Home/End jump, Right unfolds or enters, Left folds or goes to the parent (T3's `sidebarTree`, ported in `rail-tree.ts`). The page shortcuts walk the same order: next/previous agent, and next agent needing you.

### Badge and title

With the rail hidden, its button carries a badge: the needs glyph and the count of agents needing you or failed, else the working ring and the working count (Orca's activity badge). The tab title counts waiting and done agents, else working ones: `(2 waiting, 1 done) pika`, `(3 working) pika`.

## Glyphs and motion

One shape per state, 12px (after Orca's `AgentStateDot`): needs you, a filled question bubble; failed, a filled disc with a cross; done, a filled disc with a check; working, a ring open at the top; stale, a dashed ring; idle, a hollow dot; exited, a short dash. Node links: solid dot online, turning ring connecting, filled warning triangle on error, struck circle offline, dashed dot unpaired.

The working ring turns in twelve steps per second, every ring in phase (Orca's day-long `steps()` keyframe with each ring's start anchored at 0), and stands still under `prefers-reduced-motion`. There are no spinners and no other looping motion; the chevron rotates 90° on fold (no transition under reduced motion). Elapsed and relative times come from one shared clock: every second while anything works, every 30 s otherwise.

## The frame

Deck is an app of its own inside pika: its route renders outside the dashboard's `Layout`, so the black sign band and the colophon are gone and nothing scrolls the page (`web/src/nodes/deck/Chrome.tsx`).

- **App bar (40px, chrome):** the app menu on the left (the pika mark, "Deck", a chevron), opening every other pika section, Settings, Documentation, Keyboard shortcuts and Sign out; "Go to file…" with its shortcut in the middle (quick open, disabled until a node is connected); on the right the agent-list and explorer toggles (a window glyph whose panel fills while it shows; the list's toggle carries the inbox badge while hidden), a hairline, shortcuts `?`, and the theme.
- **Status bar (24px, chrome, meta type):** the browser socket (Connected, Connecting…, Reconnecting…), nodes online, "N need you" in needs ink and "N working", then "Turn on notifications" until the browser has been asked, and the server's build.
- **Workspace breadcrumb (36px):** the project is a menu button listing the node's projects (checked) and "Other terminals"; then the node, the pane's session, the focused pane's state; New terminal as a `+` icon button with its shortcut in the tooltip.
- **Rail header:** "Agents" and the Status/Projects switch; the shortcuts button and socket state moved to the bars.

## Desktop conventions

- **Cursor and selection:** the arrow everywhere, including buttons, tabs, rows and tree items; the I-beam only over text fields and selectable text. Chrome does not select: the root sets `user-select: none`, and inputs, code, `kbd`, and anything marked `data-selectable` select again (commands, fingerprints, the build).
- **Focus:** rings for the keyboard only (`:focus-visible`); a click leaves none.
- **One menu (`Menu.tsx`)** for every context menu and drop-down: a raised sheet (`dk-raised`, 1px `dk-line-strong`, 6px radius, a soft two-layer shadow), 24px items, the highlighted item in the accent with `dk-on-accent` ink whether the pointer or the keyboard put it there, shortcuts right-aligned in ink-3, separators as inset hairlines, destructive items (Kill…, Remove…) in failed ink. Arrows, Home/End, a letter to jump, Enter/Space, Escape/Tab close and return focus; a press outside, a resize or the window losing focus closes it; opening one closes any other; pressing the button that opened it closes it. Context menus exist on tabs (splits, Pin, Copy Path, Close, Close Others), agent rows (Open, Close Pane, Copy Working Directory, Kill…/Remove…), and tree items (Open or Expand/Collapse, Copy Path, Copy Relative Path, Refresh); the menu key and Shift+F10 open them from the keyboard.
- **Tooltips (`Tooltips.tsx`)** replace `title`: an inverse bubble (`dk-tip`) after 600ms, at once while another just showed, with the action's shortcut beside the name; hidden on press, key, scroll, or leaving; never on touch. The bubble is `aria-hidden`; every control keeps its own accessible name.
- **Dialogs** inside the root are sheets like the menus (8px radius, `dk-raised`, the same shadow).
- **Glyphs** are drawn SVG (chevrons, the panel toggles, the diff arrows), never Unicode triangles or arrows.
- **Scrollbars** are thin, ink at 22%.

## Chrome outside the rail

- Tab strips on chrome; the active tab on ground with a 2px accent underline; the focused group's strip has a 2px accent top line. Status glyphs on terminal tabs use the same set.
- Splitters are 1px lines that turn `dk-line-strong` on hover and accent on focus; drop targets are accent-framed over `dk-accent-soft`.
- The workspace header shows the focused pane's state as glyph plus label in the state's ink, never a boxed pill. "New terminal" is a quiet framed button; the accent is not spent on it.
- Dialogs (shortcuts, quick open) frame in `dk-line-strong`.

## Do's and Don'ts

**Do**

- Keep every Deck rule inside `[data-deck]`; read tokens from CSS, and from `DK_TOKENS` only where a canvas or Monaco needs literals.
- Give every status both its colour and its shape; keep times tabular.
- Let quiet things recede (ink-3, regular weight) and let attention carry weight.

**Don't**

- Don't use status colours for controls, selection or decoration, or the accent for status.
- Don't add spinners, gradients, glass, coloured side stripes, pills for states, or shadows for structure.
- Don't reorder rows under the pointer or yank a row the user just opened.
- Don't apply these tokens to `/docs/*` or the rest of the dashboard.

## Sources

Ported, with headers naming the source: T3 Code (`apps/web/src/lib/sidebarTree.ts` → `rail-tree.ts`; inbox ordering and grace semantics from `packages/client-runtime/src/state/threadInbox.ts`), MIT © 2026 T3 Tools Inc., notice in `web/src/nodes/workspace/T3-LICENSE`. Orca (short ages, the stepped working ring, glyph set and badge behaviour), MIT © 2026 Lovecast Inc., notice in `web/src/nodes/workspace/ORCA-LICENSE`.
