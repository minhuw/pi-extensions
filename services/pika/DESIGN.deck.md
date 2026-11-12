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
  dk-menu-line: "rgb(22 26 31 / 0.16)"
  dk-menu-hi: "rgb(90 70 200 / 0.13)"
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
  dk-on-failed: "#ffffff"
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
  dk-dark-menu-line: "#383f47"
  dk-dark-menu-hi: "rgb(165 150 255 / 0.2)"
  dk-dark-tip: "#e4e7eb"
  dk-dark-tip-ink: "#111417"
  dk-dark-ink: "#e4e7eb"
  dk-dark-ink-2: "#a6aeb8"
  dk-dark-ink-3: "#8a929c"
  dk-dark-accent: "#a596ff"
  dk-dark-on-accent: "#111417"
  dk-dark-needs: "#f2a33a"
  dk-dark-failed: "#ff7a6b"
  dk-dark-on-failed: "#111417"
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
    backgroundColor: "{colors.dk-menu-hi}"
    textColor: "{colors.dk-ink}"
    typography: "{typography.dk-ui}"
    height: "26px"
    padding: "0 8px 0 6px"
    rounded: "{rounded.dk-bar-control}"
  dk-menu-header:
    textColor: "{colors.dk-ink-3}"
    typography: "{typography.dk-meta}"
  dk-button-primary:
    backgroundColor: "{colors.dk-accent}"
    textColor: "{colors.dk-on-accent}"
    rounded: "{rounded.dk-bar-control}"
    height: "28px"
  dk-button-secondary:
    backgroundColor: "{colors.dk-raised}"
    textColor: "{colors.dk-ink}"
    rounded: "{rounded.dk-bar-control}"
    height: "28px"
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
- One accent, an indigo violet (`dk-accent`), for selection, focus, the active tab and group, splitter focus and drop targets, menu highlights (as a tint), a dialog's primary action, the terminal's selection and search, and Monaco's cursor. It never marks a status.
- Status colours, reserved: needs you amber, failed red, done green, working blue; idle and quiet are ink. Every status also has its own glyph shape, so colour is never the only cue.
- The system UI face at 13px, 11.5px metadata, tabular numerals; monospace only for terminals, code, and the browser key.

## Colors

Restrained strategy: tinted neutrals plus one accent; colour does the status job and nothing else.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Ground `dk-ground` | `#fcfcfd` | `#111417` | Terminal and editor background, active tab, page |
| Chrome `dk-chrome` | `#f1f3f5` | `#171a1e` | Rail, Explorer, tab strips, row-action chips |
| Line `dk-line` / `dk-line-strong` | `#dde1e6` / `#c3c9d0` | `#262b31` / `#383f47` | Hairlines; strong for control frames and splitter hover |
| Ink `dk-ink` / `dk-ink-2` / `dk-ink-3` | `#161a1f` / `#4f5863` / `#626a74` | `#e4e7eb` / `#a6aeb8` / `#8a929c` | Text; secondary; receded (quiet rows, times, `branch · project · node`) |
| Accent `dk-accent` | `#5a46c8` | `#a596ff` | Location and focus only; `dk-accent-soft` (11% / 15%) for the selected row and worktree card |
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
| Row title | 13px / 500; 600 when unread or selected; 400 in ink-3 when quiet | Agent rows, project headings (600), worktree cards |
| Section label | 12px / 600, ink-2, sentence case | Needs you, Failed, Done, Working, Quiet |
| Meta | 11.5px / 400, ink-3, tabular numerals | `branch · project · node`, a card's branch, times, counts, attention line |
| Mono | 13px | xterm, Monaco, the browser key |

No uppercase tracking, no eyebrow labels. Times and counts are `tabular-nums` so ticking values do not jitter.

## Density and layout

- App bar 40px, status bar 24px; panel headers (rail, workspace breadcrumb, Explorer/Changes switch) and tab strips 36px, so their bottom lines meet; controls in the bars 28px.
- Rail 280px by default, 220–500 resizable; Explorer 300px. Rail header 36px; section headers 28px; agent rows two lines (title, then `branch · project · node` or the attention text) at 5px vertical padding, about 40px; activity rows 24px, indented 18px from their agent's text.
- Spacing steps of 4px; rows use 12px side padding. In the Projects view: project headings 12px (after the chevron), checkout rows 24px, worktree cards 32px, their agents 44px.
- Rows draw with `content-visibility: auto` (`contain-intrinsic-size: auto 40px`), so a long rail lays out only what is on screen.
- Radius 2–3px on controls only; rows, sections, tab strips and panels are square.

## The rail

### Status view (the default): the inbox

One list for every agent on every node, in sections by what the user has to do (`web/src/nodes/workspace/inbox.ts`):

| Section | An agent is here when | Right slot | Second line |
| --- | --- | --- | --- |
| Needs you | Merged state `waiting`: OSC 7501 `blocked`, the bridge waiting, or a waiting activity | Kind (Permission / Question / Login) in needs ink, then age | The dialog's message, or "<activity> is waiting" |
| Failed | pi's program status `error`, or exited with a nonzero code | Age | The error message, or "Exited with code N" |
| Done | Idle and unread (finished since last seen) | Age; title semibold with a green dot | `branch · project · node` |
| Working | Busy (pi's turn or background activities) | Ticking elapsed time, `2m14s` | `branch · project · node`, or "No update in 34m" when stale |
| Quiet | Idle and seen, or ended by itself (exit 0 or a signal) | Age, or "Exited" | `branch · project · node` |

- **Order:** within a section, newest return to the user first (T3 Code's `sortInboxThreadsByReturn`); Working keeps terminal creation order so it does not shuffle as agents take turns.
- **Exit grace:** an agent that stops working stays in Working for 2 s (T3's `WORKING_EXIT_GRACE_MS`), so pi idling between a turn and its retry, compaction or queued message does not flicker it out. Needing the user, failing, or exiting show at once.
- **Pointer hold:** while the pointer is over the list, rows keep their places (a changed glyph still updates); they move when it leaves.
- **Selection hold:** an agent the user opens from Done stays in Done, marked seen, until they move to another agent.
- **Staleness:** a Working agent whose status has not changed for 30 min shows a dashed still ring and "No update in …" (Orca's freshness rule).
- **Sections:** header with chevron, label and count; empty sections hide, except Needs you, which says "Nothing needs you". Quiet starts folded; folding is remembered (`pika.nodes.rail`).
- **Row:** status glyph, label (pi session name, else terminal title, else program, else "Shell"), right status slot, second line. The second line names its worktree's branch and its project (a folder's project alone; a terminal in no listed worktree, its folder's name). Click: switch to the agent's worktree, activate its tab, focus its pane, mark it seen.
- **Hover actions** replace the status slot in place, without moving anything: Close pane (only when the agent has a pane in a workspace), and Kill, or Remove for an exited terminal. They also show on keyboard focus.
- **Background activities** (subagents, Herder steps, from a live bridge) list under their agent, waiting first, up to four, with progress and elapsed time, then "N more"; clicking one opens the agent.
- **Nodes:** a compact strip at the top lists every node with its link state; it is the way to a node with no agents and to pairing. Rows of a node that is not connected show at 60% opacity with the state on the row (Orca's disconnected host). Chosen over a per-row marker only because a node with no agents would otherwise be unreachable from the rail.

### Projects view

The toggle in the rail header switches to Orca's levels: node → project → checkout → worktree card → agents (`NODE.md`, "Checkouts"). A node reports checkouts (a repository's common dir with its worktrees, or a plain folder); the server's project key (`POST deck/project-keys`, asked in batches and kept for the page) groups them, so clones of one remote are one project and a fork is another. A checkout whose key is not known yet joins the others of its repository for now; one with no key is a project of its own.

- **Node header:** link glyph and state; folds in this browser.
- **Project heading (28px, 13px/600):** chevron, the server's name for the project (`deck/projects`) else its first checkout's name, the path of its only checkout, and, folded, its strongest status glyph and agent count (T3's aggregated dot). A click folds it; the server keeps folding for every browser (a project without a key folds in this browser). F2 or Rename Project… names it on the server. Its menu: New Worktree… (a submenu of checkouts when there are several), Rename Project…, Collapse, Copy Repository URL; with one checkout, that checkout's items too.
- **Checkout row (24px, monospace path in ink-2):** only when the node has two or more checkouts of the project; otherwise the heading stands for it. Menu: Rename on <node>…, Worktree Settings… (where new worktrees go, the base, a setup script), Reveal in Explorer, Copy Path, Keep in Deck (one found on its own), Remove from Deck (hidden on the node, with a five-second Undo).
- **Worktree card (two lines):** the folder's name with `detached`, `locked`, `prunable` markers, then the branch (or short commit) in monospace with a branch glyph; the main worktree first. A click shows its workspace. Menu: New Terminal, New pi Agent, Reveal in Explorer, Copy Path, Copy Branch Name, Remove Worktree… (linked ones only).
- **Agents** sit under the card of the worktree their node places them in (the shell's live cwd), in the inbox's order. Terminals in no listed worktree go under the node's "Other" card.
- **Shown:** projects with agents, the one on screen, and checkouts added by hand; the rest wait behind "N more projects". The filter matches agents and project names, paths, and branches.

Split layouts are kept per worktree (`node + checkoutId + worktreePath`, workspace store version 2; the old per-project layouts are dropped).

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
- **Workspace breadcrumb (36px):** the place (`branch · project`) is a menu button listing the node's worktrees under their projects (checked) and "Other terminals"; then the node, the pane's session, the focused pane's state; New terminal as a `+` icon button with its shortcut in the tooltip.
- **Rail header:** "Agents" and the Status/Projects switch; the shortcuts button and socket state moved to the bars.

## Desktop conventions

- **Cursor and selection:** the arrow everywhere, including buttons, tabs, rows and tree items; the I-beam only over text fields and selectable text. Chrome does not select: the root sets `user-select: none`, and inputs, code, `kbd`, and anything marked `data-selectable` select again (commands, fingerprints, the build).
- **Focus:** rings for the keyboard only (`:focus-visible`); a click leaves none.
- **Primitives:** menus, tooltips, dialogs, confirmations, the Add Repository completion list, the undo notice, buttons inside dialogs, text fields and checkboxes are shadcn/ui components on Base UI (`@base-ui/react`), copied into `web/src/components/ui-shadcn/` and restyled with the `dk-*` utilities; Base UI does the keyboard, focus, dismissal, placement and ARIA. They portal into the Deck root (`PortalContainer`), so the tokens reach them. Nothing hand-rolls a menu, a bubble or a modal frame any more.
- **One menu (`Menu.tsx`, data drawn by `ui-shadcn/dropdown-menu.tsx`)** for every context menu and drop-down, drawn like a native one (macOS, Zed, VS Code):
  - **Sheet:** `dk-raised`, a 1px `dk-menu-line` hairline, 6px radius, the soft two-layer `dk-shadow`, 4px inside; 220–380px wide.
  - **Rows:** 26px, 13px text in full ink, 6px/8px side padding, 4px radius. A 16px icon column always comes first (the item's 14px icon in ink-2, the check of a chosen one, or blank), then the label, a hint in ink-3 at 12px that truncates first (a worktree's path), the shortcut right-aligned in ink-3 tabular figures, and a chevron for a submenu.
  - **Highlight:** the accent tint `dk-menu-hi` (13% light, 20% dark) with the text staying ink, whether the pointer or the keyboard put it there; the item whose submenu is open stays highlighted. Destructive items (Kill, Remove, Re-pair…) are failed ink with a failed-ink icon, highlighted or not.
  - **Groups:** separators are inset hairlines with 4px above and below; a header names the items under it (11.5px, 600, ink-3, aligned with the labels) and makes them a `group` for assistive technology. A note is one line of ink-2 text where there is nothing to choose.
  - **Disabled is rare.** A menu is never a list of disabled items. What cannot apply here is left out (splits for a group's only tab, Close Others with nothing to close, a fingerprint never pinned); a node that is not connected leaves out everything that needs it and the menu says so once, in a note ("node01 is not connected"). An item stays disabled only when that teaches something, today only "Update pika-node on X to use this". Disabled text is ink at 40%; the item can still be highlighted (with a hover tint, not the accent), and its reason shows once, in a tooltip bubble beside the menu, and is the item's `aria-describedby`; never a second line under every item.
  - **Placement:** under the button or row that opened it, or with its corner at the pointer for a context menu (a virtual anchor); it flips above or to the left rather than run off the window, 4px from its edge.
  - **Submenus** open beside their item, first rows level (flipping left at the window's edge), when the pointer rests on it, on a click, or with Right, Enter or Space; Left or Escape closes one and returns to its item.
  - **Keyboard:** opened from the keyboard (Enter on its button, the menu key, Shift+F10), focus starts on the checked or first enabled item; opened by the pointer, nothing is highlighted until an arrow or the pointer picks a row, as on the desktop. With only a note the sheet itself takes focus, so Escape still works. Arrows wrap, a letter jumps by label, Enter/Space choose, Escape closes and returns focus. A chosen item returns focus where it was before it runs, so the item may move it on (a dialog, a file). A press outside the menu and its submenus (leaving focus where the press puts it), a resize or the window losing focus closes it; opening one closes any other; pressing the button that opened it closes it. Context menus exist on tabs, agent rows, project headings, checkout rows, worktree cards, nodes and tree items.
  - **The rail's "+"** targets a node: the node on screen (or the only connected one) without asking, under a header naming where things land ("atlas · main · mac") when there is a worktree on screen or another node; the worktree on screen is the default, and New Worktree… (of its checkout) appears only there. Other connected nodes follow as submenus under "Other nodes". With no node on screen and up to four connected, each is a group under its name, so one choice picks node and action; beyond four, one submenu per node. With none connected, it offers "Pair <node>…" for each unpaired node, or says which nodes are not connected.
- **Buttons:** 28px, 4px radius. In dialogs they are `ui-shadcn/button.tsx` (`default` the accent, as a desktop's default button: Add Repository, Create Worktree; `outline` framed in `dk-line-strong` on `dk-raised`; `ghost` quiet; `destructive` a `dk-failed` fill with `dk-on-failed` text: Kill, Remove Worktree, Forget the Key). Elsewhere the shared `BUTTON` set is re-toned to the same look through its `ui-button*` names. Text fields are 28px, `dk-line-strong`, turning accent with a soft accent ring on focus; checkboxes are 14px boxes filled with the accent when checked.
- **Tooltips (`Tooltips.tsx`)** replace `title`: an inverse bubble (`dk-tip`) after 600ms, at once while another just showed, with the action's shortcut beside the name; hidden on press, key, scroll, or leaving; never on touch. One Base UI tooltip, anchored to the control under the pointer, serves every `data-tip`: below it, above at the window's bottom, kept 4px inside the window. The bubble is `aria-hidden`; every control keeps its own accessible name.
- **Dialogs** are sheets like the menus (8px radius, `dk-raised` framed in `dk-line-strong`, the same shadow) over a 30% (dark: 50%) backdrop, named by their title and described by their first line. Focus goes to the first field, or to Cancel in a confirmation, stays inside, and returns when they close; Deck's shortcuts stand still while one is open (the popup says `aria-modal`). Escape cancels unless an action is in flight. A press on the backdrop cancels a dialog but not a confirmation (`role="alertdialog"`: kill, close unsaved, remove a worktree, forget a key). New Worktree shows the branch (as typed) and the folder it lands in (`<location>/<repo>-<slug>`) as the name is typed, starts from the checkout's base, and opens the setup script's terminal when the node starts one. Remove Worktree keeps the branch unless "Also delete branch" is checked; when terminals run in it, the node refuses and the button becomes "Stop N terminals and Remove"; git's refusal (changes, untracked files, a lock) shows in place. Add Repository lists the node's folders under its field (Base UI Autocomplete): arrows pick, Tab or Enter or a click completes, Enter with nothing picked adds the path.
- **The undo notice** (after Remove from Deck) is a Base UI toast at the bottom left, above the status bar: the message, Undo in the accent, five seconds held while the pointer or focus is on it, announced politely; a failed undo replaces the message.
- **Glyphs** are drawn SVG (chevrons, the panel toggles, the diff arrows), never Unicode triangles or arrows.
- **Scrollbars** are thin, ink at 22%.

## Chrome outside the rail

- Tab strips on chrome; the active tab on ground with a 2px accent underline; the focused group's strip has a 2px accent top line. Status glyphs on terminal tabs use the same set.
- Splitters are 1px lines that turn `dk-line-strong` on hover and accent on focus; drop targets are accent-framed over `dk-accent-soft`.
- The workspace header shows the focused pane's state as glyph plus label in the state's ink, never a boxed pill. "New terminal" is a quiet framed button; the accent is not spent on it.
- An empty tab group offers "New terminal" once, as a labelled button in its body; its strip has no `+` until it holds a tab.

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

Ported, with headers naming the source: T3 Code (`apps/web/src/lib/sidebarTree.ts` → `rail-tree.ts`; inbox ordering and grace semantics from `packages/client-runtime/src/state/threadInbox.ts`), MIT © 2026 T3 Tools Inc., notice in `web/src/nodes/workspace/T3-LICENSE`. Orca (short ages, the stepped working ring, glyph set and badge behaviour), MIT © 2026 Lovecast Inc., notice in `web/src/nodes/workspace/ORCA-LICENSE`. shadcn/ui (the Base UI flavour of `dropdown-menu`, `tooltip`, `dialog`, `alert-dialog`, `button`, `input`, `checkbox`, `toast`, and its combobox for the autocomplete), MIT © 2023 shadcn, notice in `web/src/components/ui-shadcn/SHADCN-LICENSE`, which also records the dependencies: Base UI (`@base-ui/react`, MIT © 2019 Material-UI SAS), clsx and tailwind-merge (MIT), class-variance-authority (Apache-2.0).
