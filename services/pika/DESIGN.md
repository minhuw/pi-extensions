---
name: Pi extensions documentation
description: Swiss Typographic Concordance / 瑞士网格命令速查册 for /docs/* only; applies to web/src/pages/Docs.tsx and web/src/docs, excluding pika session and dashboard interfaces.
colors:
  docs-ink: "#141413"
  docs-muted: "#59564f"
  docs-accent: "#c83214"
  docs-rule: "#dfdbd2"
  docs-strong-rule: "#b8b2a6"
  docs-ink-rule: "#141413"
  docs-ground: "#f2efe9"
  docs-paper: "#faf8f4"
  docs-input: "#ffffff"
  docs-selected: "#faf8f4"
  docs-selection-ink: "#c83214"
  docs-dark-ink: "#edebe6"
  docs-dark-muted: "#a6a298"
  docs-dark-accent: "#f26b4e"
  docs-dark-rule: "#2a2926"
  docs-dark-strong-rule: "#524f49"
  docs-dark-ink-rule: "#45433e"
  docs-dark-ground: "#1b1b19"
  docs-dark-paper: "#141413"
  docs-dark-input: "#141413"
  docs-dark-selected: "#141413"
  docs-dark-selection-ink: "#f26b4e"
typography:
  docs-display:
    fontFamily: '"Aileron", "Docs Public Sans", sans-serif'
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.03em"
  docs-display-mobile:
    fontFamily: '"Aileron", "Docs Public Sans", sans-serif'
    fontSize: "27px"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.025em"
  docs-headline:
    fontFamily: '"Aileron", "Docs Public Sans", sans-serif'
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  docs-title:
    fontFamily: '"Aileron", "Docs Public Sans", sans-serif'
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  docs-subheading:
    fontFamily: '"Aileron", "Docs Public Sans", sans-serif'
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.45
  docs-body:
    fontFamily: '"Docs Public Sans", "Aileron", sans-serif'
    fontSize: "15.5px"
    fontWeight: 400
    lineHeight: 1.62
  docs-label:
    fontFamily: '"Aileron", "Docs Public Sans", sans-serif'
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.62
  docs-filter-label:
    fontFamily: '"Aileron", "Docs Public Sans", sans-serif'
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.62
  docs-directory:
    fontFamily: '"Docs Public Sans", "Aileron", sans-serif'
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.38
  docs-contents:
    fontFamily: '"Docs Public Sans", "Aileron", sans-serif'
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.42
  docs-caption:
    fontFamily: '"Docs Public Sans", "Aileron", sans-serif'
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.62
  docs-command-label:
    fontFamily: '"Aileron", "Docs Public Sans", sans-serif'
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.62
    letterSpacing: "0.05em"
  docs-code:
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  docs-square: "0px"
  docs-small: "2px"
spacing:
  docs-4: "4px"
  docs-6: "6px"
  docs-8: "8px"
  docs-10: "10px"
  docs-12: "12px"
  docs-14: "14px"
  docs-16: "16px"
  docs-18: "18px"
  docs-20: "20px"
  docs-24: "24px"
  docs-28: "28px"
  docs-32: "32px"
  docs-40: "40px"
  docs-44: "44px"
  docs-56: "56px"
components:
  docs-icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.docs-ink}"
    rounded: "{rounded.docs-small}"
    width: "32px"
    height: "32px"
  docs-icon-button-hover:
    backgroundColor: "{colors.docs-ground}"
    textColor: "{colors.docs-accent}"
  docs-copy-button:
    backgroundColor: "transparent"
    textColor: "{colors.docs-muted}"
    typography: "{typography.docs-caption}"
    rounded: "{rounded.docs-small}"
    padding: "2px 6px"
  docs-copy-button-hover:
    backgroundColor: "{colors.docs-paper}"
    textColor: "{colors.docs-accent}"
  docs-header-search:
    backgroundColor: "{colors.docs-input}"
    textColor: "{colors.docs-ink}"
    rounded: "{rounded.docs-small}"
    padding: "0 11px"
    width: "256px"
    height: "32px"
  docs-content-search:
    backgroundColor: "{colors.docs-input}"
    textColor: "{colors.docs-ink}"
    rounded: "{rounded.docs-small}"
    padding: "0 13px"
    width: "100%"
    height: "42px"
  docs-section-tabs:
    textColor: "{colors.docs-muted}"
    typography: "{typography.docs-label}"
  docs-section-tabs-current:
    textColor: "{colors.docs-ink}"
  docs-filter-chip:
    backgroundColor: "transparent"
    textColor: "{colors.docs-muted}"
    typography: "{typography.docs-filter-label}"
    padding: "5px 0 6px"
  docs-filter-chip-active:
    textColor: "{colors.docs-ink}"
  docs-directory-link:
    textColor: "{colors.docs-ink}"
    typography: "{typography.docs-directory}"
    rounded: "{rounded.docs-square}"
    padding: "4px 10px"
  docs-directory-link-current:
    backgroundColor: "{colors.docs-selected}"
    textColor: "{colors.docs-selection-ink}"
  docs-contents-link:
    textColor: "{colors.docs-muted}"
    typography: "{typography.docs-contents}"
  docs-contents-link-current:
    textColor: "{colors.docs-accent}"
  docs-command-table:
    textColor: "{colors.docs-ink}"
    width: "100%"
  docs-code-surface:
    backgroundColor: "{colors.docs-ground}"
    textColor: "{colors.docs-ink}"
    rounded: "{rounded.docs-square}"
  docs-guide-strip:
    textColor: "{colors.docs-ink}"
    width: "100%"
  docs-search-result:
    textColor: "{colors.docs-ink}"
    padding: "16px 0"
---

# Design System: Pi extensions documentation

## Overview

**Creative North Star: "Swiss Typographic Concordance / 瑞士网格命令速查册"**

This is the independent documentation identity for `/docs/*`, implemented by `web/src/pages/Docs.tsx` and `web/src/docs`. It serves users looking up Pi extension commands, configuration, and reference material. Warm archival paper, a stone directory and code ground, exposed one-pixel structural rules, crisp neo-grotesque headings, and a restrained International Vermilion accent give the collection the character of a Swiss typographic concordance (Ulm / Müller-Brockmann technical index): immediate, scannable, and dense enough to surface the command index in the first viewport.

The system is flat, structural, and typographic. Continuous one-pixel hairlines align the masthead wordmark cell, left directory rail, central reference sheet, and right page-outline rail; inline category filter tabs narrow the command concordance in place; and code remains selectable inside its own stone surface. Confirmed visual rejections ban decorative kickers or eyebrows above headings, hero stat boxes, ornamental section numbering, monospace styling on non-code labels, Unicode glyph stand-ins, and nested card chrome. These tokens and rules apply only to `/docs/*`. Existing pika session, dashboard, and public trajectory interfaces retain their separate incumbent identity and are outside this design system. No rule here is a global design ban or a replacement for pika's product or logo commitments.

**Key Characteristics:**

- Warm archival reading paper with a stone navigation and code ground, deep carbon ink, and exposed structural hairlines.
- Self-hosted Aileron neo-grotesque for headings, masthead navigation, filter tabs, table headers, and index titles, paired with self-hosted Public Sans for long-form prose.
- High-density command concordance with inline typographic category filtering, boxed monospace command tokens, and a three-column guide strip.
- Continuous exposed one-pixel grid connecting the 54px masthead, 236px directory rail, central sheet, and 224px page-outline rail.
- Matching light and dark roles, single-frame input focus, and compact mobile disclosures.

**Evidence:** `web/src/docs/docs.css` is the token and layout source; `web/src/pages/Docs.tsx` and `web/src/docs/DocMarkdown.tsx` establish the component structures and states, corroborated by the desktop, article, dark-article, and mobile captures in `.impeccable/review/`. Where the preliminary surface brief noted `#5C5952` muted ink, `#DEDAD0` rules, and a 196px default right rail, the shipped CSS settles on `#59564f`, `#dfdbd2`, and a 224px right rail above 1280px (196px at `<=1280px`). `Docs Source Serif` was removed and replaced by `Aileron`. Font origins and licenses are in `web/src/docs/fonts/SOURCES.txt`, `web/src/docs/fonts/LICENSE-publicsans.txt`, and `web/src/assets/fonts/LICENSE-Aileron.txt`.

Frontmatter owns normative primitives. Names beginning `docs-dark-` are the dark counterparts assigned to `--docs-*` under `[data-theme="dark"] .docs-app`. The app also maps `--color-ink`, `--color-muted`, and `--color-page` so shared syntax highlighting inherits the docs palette. Sidecar tonal ramps are panel illustrations, not additional shipping palette tokens.

## Colors

The palette pairs warm archival paper, stone support surfaces, and carbon ink with three structural rule weights and a single International Vermilion accent, adapting cleanly to dark carbon paper.

### Primary

- **International Vermilion** (`docs-accent`): links, active masthead and filter-tab underlines, active directory and outline left rules, focus outlines, input carets, and checkboxes.
- **Directory selection fill** (`docs-selected`) and **selection ink** (`docs-selection-ink`): paired background and foreground for the active directory entry (`[aria-current]`), lifting the active row onto warm paper with vermilion text and a vermilion left rule.
- **Dark counterparts** (`docs-dark-accent`, `docs-dark-selected`, `docs-dark-selection-ink`): preserve those roles against dark carbon surfaces.

### Neutral

- **Deep carbon ink** (`docs-ink`) and **warm graphite secondary ink** (`docs-muted`): primary reading and heading text vs quieter descriptions, metadata, inactive tabs, table headers, and placeholders.
- **Warm archival paper** (`docs-paper`): masthead and central reading sheet. **Stone ground** (`docs-ground`): directory rail, code containers, inline code badges, and icon-button hover fills. **Crisp input ground** (`docs-input`): search fields.
- **Exposed hairline** (`docs-rule`): grid rail dividers, table row borders, directory group dividers, and code toolbar borders. **Strong hairline** (`docs-strong-rule`): search input borders, code container frames, table header bottom borders, blockquote rules, and scrollbar thumbs. **Structural ink rule** (`docs-ink-rule`): primary horizontal anchors under the masthead, page header, first prose `h1`, article footer, and the top edge of tables, guide strips, extension matrices, and search result lists.
- Each neutral has a `docs-dark-` counterpart. Dark `docs-dark-ink-rule` softens to a warm charcoal rule while `docs-dark-paper`, `docs-dark-input`, and `docs-dark-selected` share a deep carbon surface. Native text `::selection` uses `#e6e1d6` / `#141413` in light mode and `#2f2d28` / `#f5f3ee` in dark mode.

### Named Rules

**The Docs Location Rule.** Reserve the vermilion accent for links, active location markers (two-pixel tab underlines and one-pixel directory/outline left rules), and keyboard focus; pair selection fill with selection ink for the active directory entry.

**The Three-Weight Hairline Rule.** Distinguish structural anchors (`docs-ink-rule`), interactive or container frames (`docs-strong-rule`), and internal cell or row subdivisions (`docs-rule`) by border tone rather than by drop shadows or thick borders.

Links use a 4px underline offset and gain an underline on hover. Focusable links, buttons, disclosures, and scroll regions use a 2px vermilion outline (`outline-offset: 2px`). Search inputs use single-frame focus (`outline: 2px solid var(--docs-accent); outline-offset: -1px; border-color: var(--docs-accent)`). Programmatic focus on `.docs-main` is unoutlined.

## Typography

**Display & Structural Font:** Aileron (`"Aileron", "Docs Public Sans", sans-serif`), self-hosted WOFF2 faces (400, 400 italic, 600, 700) in `web/src/assets/fonts/`.

**Body Font:** Public Sans, registered as `Docs Public Sans` (`"Docs Public Sans", "Aileron", sans-serif`), self-hosted variable WOFF2 faces (normal and italic, weights 400–700) in `web/src/docs/fonts/` with `font-display: swap`.

**Code Font:** the native monospace stack recorded in `docs-code` (`ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`).

Aileron gives headings, masthead navigation, filter tabs, table headers, and index titles the authority of a Swiss technical index; Public Sans keeps reading prose and compact navigation rails calm and legible; monospace is reserved strictly for commands and code syntax.

### Hierarchy

| Role | Token | Application |
| --- | --- | --- |
| Display | `docs-display`; `docs-display-mobile` at `<=760px` | Page and chapter `h1`; balanced wrapping, zero margin in `.docs-page-head`, or 12px bottom padding and 18px bottom margin on `.docs-prose > h1:first-child`. |
| Headline | `docs-headline` | `h2` sections; 8px bottom margin, with 32px top margin, 16px top padding, and a top hairline in prose (suppressed right after `h1:first-child`). |
| Title | `docs-title` | `h3` subsections; 24px above and 8px below. |
| Subheading | `docs-subheading` | `h4`–`h6` headings; 20px above and 6px below. |
| Body | `docs-body` | Reading text; 14px bottom margin on paragraphs; `68ch` max measure on prose blocks, intros, and search descriptions. |
| Label | `docs-label` | Masthead section tabs (`Reference`, `Guides`, `Commands`, `Deploy`). |
| Filter label | `docs-filter-label` | Inline command category filter tabs (`.docs-filter-chip`). |
| Directory | `docs-directory` | Left directory links; active entries use weight 600. |
| Contents | `docs-contents` | Right-margin outline links; active entries use weight 600. |
| Caption | `docs-caption` | Code toolbar status and Copy button label. |
| Command heading | `docs-command-label` | Uppercase table headers (`th`), directory group headings, and margin section headings (`11px`, weight 700, uppercase; `0.05em` tracking on `th`, `0.06em` on rail headings). |
| Code | `docs-code` | Preformatted code blocks (`12.5px/1.55`), inline code, and command badges (`12.5px`). |

Component Aileron titles use 16px (`17px` mobile) for the wordmark, 17px for search result titles, 14.5px for extension matrix links, 14px for guide strip links, and 13px for the search label (all weight 700). Intro copy and search descriptions are 14.5px; table cells and extension descriptions are 13.5px.

### Named Rules

**The Docs Concordance Type Rule.** Use Aileron for structural headings, masthead navigation, category filter tabs, uppercase table headers, and index titles; use Public Sans for reading prose and navigation rails; reserve monospace strictly for actual commands, code blocks, and code language identifiers.

## Layout

The desktop frame is an exposed one-pixel Swiss grid:

1. **Sticky masthead** (`54px` tall, `z-index: 30`): spans `docs-paper` with a `1px solid var(--docs-ink-rule)` bottom border. Its `236px` wordmark cell (`padding: 0 24px`, `border-right: 1px solid var(--docs-rule)`) aligns with the `236px` left directory rail. Section tabs use `padding-left: 18px` and `26px` gap; the right search cluster sits behind a `1px solid var(--docs-rule)` left divider (`padding-left: 18px`).
2. **Sticky directory rail** (`236px` wide): scrolls independently below the masthead (`max-height: calc(100dvh - 54px)`) on `docs-ground` with `20px 18px 28px 24px` padding and `14px` section spacing divided by `1px solid var(--docs-rule)`.
3. **Reading sheet** (`.docs-sheet`): sits on `docs-paper` with a `1px solid var(--docs-rule)` left border and a `minmax(0, 1fr) 224px` grid. `.docs-main` (`padding: 24px 44px 56px 44px`) is separated by a continuous `1px solid var(--docs-rule)` right border from `.docs-margin` (`224px` wide, `24px 24px 28px` padding).

Anchor targets use `calc(var(--docs-header-height) + 28px)` of `scroll-margin-top`. A skip link (`.docs-skip`) appears at `top: 10px; left: 24px` on focus.

### Responsive behavior

| Viewport | Shipped adaptation |
| --- | --- |
| Above 1280px | 54px masthead, 236px directory, fluid main column (`24px 44px 56px 44px`), and 224px outline rail; masthead search is 256px; command/extension columns are 170px/130px. |
| At or below 1280px | Outline rail narrows to 196px; `.docs-main` side padding becomes 34px left / 32px right; masthead search becomes 220px; command/extension columns become 150px/115px. |
| At or below 1100px | `.docs-margin` hides and `.docs-main` drops its right border (`32px` side padding). In-flow `.docs-mobile-contents` ("On this page", `260px` max scroll height) appears at the top of `.docs-main`. Masthead tab gap is 18px, search is 196px, and the GitHub link hides. |
| At or below 760px | Masthead becomes two rows totaling `92px` (50px top bar with wordmark and 38×38px icon buttons; 41px tab bar with `22px` gap and top rule). Directory opens as a sticky two-column drawer (`padding: 20px 22px`, `24px` column gap, `max-height: min(65dvh, 500px)`, ink bottom rule). `.docs-main` padding is `22px 20px 44px`; `h1` uses `docs-display-mobile`; the 3-column guide strip and 2-column extension list collapse to single columns. |

At `<=760px`, `.docs-command-table` uses `table-layout: fixed` with **two visible columns: Command (`44%`) and Purpose**. The standalone Extension column hides, and `.docs-command-owner` appears beneath each command badge (`margin-top: 4px`, `11.5px` weight 500, muted link) with `12px` vertical cell padding and top alignment. On `@media print`, navigation and toolbars hide and `.docs-main` prints unbordered in `#141413` on `#ffffff`.

## Elevation & Depth

The documentation CSS defines no shadows. Region hierarchy is conveyed strictly through surface tone (`docs-paper`, `docs-ground`, `docs-input`), the three hairline weights (`docs-ink-rule`, `docs-strong-rule`, `docs-rule`), and active border/text accents.

### Named Rules

**The Docs Flat Reference Rule.** Separate documentation regions with paper, stone ground, and one-pixel structural hairlines; never introduce drop shadows, blurred glass headers, or floating cards.

Motion is restricted to `140ms ease-out` transitions on `.docs-contents-links a` and `.docs-filter-chip` (`color`, `background-color`, `border-color`) when `prefers-reduced-motion: no-preference` matches.

## Shapes

Structural containers—masthead, reading sheet, directory rows, outline links, tables, guide strip, extension matrix, and code blocks—are square-edged (`docs-square`, `0px`). Subtle rounding (`docs-small`, `2px`) belongs only to icon buttons, search inputs, copy buttons, inline `code`, and boxed command badges. Borders are `1px`, stepped to `2px` only for active tab underlines and `:focus-visible` outlines. Drawn SVG icons use a 16-unit viewBox with `1.4` stroke width and round caps/joins (`17–18px` in masthead controls, `14px` in external links, `13px` in copy buttons).

## Components

The sidecar contains nine self-contained specimens with `var(--docs-*)` fallbacks, inline SVG icons, and `:hover`/`:focus-visible` rules. Routing, search indexing, theme state, and clipboard writes remain in the React components.

### Quiet icon buttons

Theme, mobile search, and mobile directory controls (`docs-icon-button`) are `32×32px` on desktop (`38×38px` with `margin-top: 6px` at `<=760px`), using `border: 1px solid transparent`, `2px` radius, transparent background, and `docs-ink` foreground. Hover applies `docs-ground` fill, `docs-rule` border, and `docs-accent` icon color.

### Code surfaces and copy button

Code containers (`.docs-code`) use `docs-ground`, `1px solid var(--docs-strong-rule)`, and `0px` radius (`margin: 14px 0`, or `0` inside `.docs-performance`). Code uses `docs-code` with `10px 16px` padding (`10px 14px` on mobile) inside a focusable horizontal scroll container (`.docs-code-scroll`).
- **Language-labeled or status-active blocks** place `.docs-code-tools` as a top header bar (`min-height: 28px`, `padding: 2px 10px 2px 14px`, `border-bottom: 1px solid var(--docs-rule)`) with `.docs-code-lang` (`11px` mono) on the left and Copy on the right.
- **Language-less single-row code bars** (`.docs-code:not(:has(.docs-code-lang)):not(:has([role="status"]:not(:empty)))`) render as a single flex row: `.docs-code-scroll` stretches on the left (`flex: 1`) and `.docs-code-tools` becomes a right-hand cell (`padding: 0 8px`, `border-left: 1px solid var(--docs-rule)`, `border-bottom: 0`).
- **Copy button** (`docs-copy-button`): `13px` icon + `11.5px` weight 500 label (`padding: 2px 6px`, `2px` radius), shifting to `docs-paper` background, `docs-rule` border, and `docs-accent` ink on hover.

### Search fields and results

Both search inputs use `docs-input`, `1px solid var(--docs-strong-rule)`, `2px` radius, `docs-muted` placeholders, `docs-accent` caret, and single-frame focus (`outline-offset: -1px`):
- **Masthead search** (`docs-header-search`): `256×32px` (`13px` text, `padding: 0 11px`) inside a `1px solid var(--docs-rule)` left-bordered cell; hidden on `/docs/search` via `.docs-header-search-hidden`.
- **Content search** (`docs-content-search`): `100%×42px` (`15px` text, `padding: 0 13px`) beneath an Aileron `13px` weight 700 `.docs-search-label`.
- **Search results** (`.docs-search-results`): framed by `border-top: 1px solid var(--docs-ink-rule)` and `1px solid var(--docs-rule)` row dividers (`16px 0` link padding), stacking an Aileron `17px` weight 700 ink title (`docs-accent` + underlined on hover), `12px` muted context, and `14.5px` ink description (`68ch` max).

### Masthead tabs, directory, and outline rails

- **Masthead tabs** (`.docs-tabs`): Aileron `13.5px` weight 600 (`gap: 26px`, `padding-left: 18px`), `docs-muted` at rest and `docs-ink` on hover or `[aria-current]`, with a `2px` `docs-accent` bottom rule (`bottom: -1px`).
- **Directory rail** (`.docs-directory`): `11px` weight 700 uppercase headers (`0.06em` tracking, `docs-muted`) above `13.5px/1.38` links (`padding: 4px 10px`, `margin-left: -10px`, `border-left: 1px solid transparent`). `[aria-current]` uses `docs-selected` fill, `docs-selection-ink` text, `border-left-color: var(--docs-accent)`, and weight 600.
- **Page outline & Quick reference** (`.docs-margin`): `12.5px/1.42` links (`gap: 8px`) along a `1px solid var(--docs-rule)` left line (`padding-left: 13px`, nested `h3` at `23px`); `[aria-current="location"]` uses `docs-accent` text, `border-left-color: var(--docs-accent)`, and weight 600. A `1px solid var(--docs-rule)` top border separates "Quick reference" below.

### Category filter strip, command concordance, and reference matrices

- **Category filter strip** (`.docs-filter-strip`): flex toolbar (`gap: 2px 18px`, `border-top: 1px solid var(--docs-rule)`) with inline `.docs-filter-chip` buttons (`padding: 5px 0 6px`, `margin-bottom: -1px`, `border-bottom: 2px solid transparent`, Aileron `12.5px` weight 600, `docs-muted`) that turn `docs-ink` with a `docs-accent` bottom bar when `aria-pressed="true"`.
- **Command concordance** (`.docs-command-table`): semantic `100%` table (`13.5px`, `tabular-nums`, `border-top: 1px solid var(--docs-ink-rule)`) with Aileron `11px` weight 700 uppercase headers (`padding: 7px 14px 7px 0`, `border-bottom: 1px solid var(--docs-strong-rule)`). Desktop rows use `7.5px` vertical padding (`170px` Command, `130px` Extension). Command `<code>` tokens sit in a `2px`-rounded stone badge (`padding: 1px 6px`, `background: var(--docs-ground)`, `border: 1px solid var(--docs-rule)`) whose border and ink turn `docs-accent` on hover.
- **Guide strip** (`.docs-guide-strip`) & **Extension matrix** (`.docs-page-list`): `.docs-guide-strip` is a 3-column grid (`border-top: 1px solid var(--docs-ink-rule)`, `border-bottom: 1px solid var(--docs-rule)`, `1px solid var(--docs-rule)` vertical dividers, `11px 16px` cell padding, Aileron `14px` weight 700 titles, `12.5px` descriptions). `.docs-page-list` is a 2-column grid (`column-gap: 32px`, `border-top: 1px solid var(--docs-ink-rule)`, `12px 0` item padding with `1px solid var(--docs-rule)` bottom borders, Aileron `14.5px` weight 700 titles, `13.5px` descriptions capped at `65ch`).

## Do's and Don'ts

### Do:

- **Do** apply this system only to `/docs/*` (`web/src/pages/Docs.tsx` and `web/src/docs`); preserve the separate incumbent identity of pika's session, dashboard, and public trajectory interfaces.
- **Do** use the Docs Location Rule and Three-Weight Hairline Rule to structure navigation, tables, and active states in both light and dark themes.
- **Do** use the Docs Concordance Type Rule and keep reading prose within its observed `68ch` maximum measure.
- **Do** use the single-row flex code bar with a right-hand `1px`-divided Copy cell for language-less command specimens, and the top toolbar with `.docs-code-lang` for language-labeled blocks.
- **Do** hide the masthead search form on `/docs/search` (`.docs-header-search-hidden`) and use single-frame focus (`outline-offset: -1px`) on search inputs.
- **Do** retain the mobile two-column command/purpose concordance adaptation with `.docs-command-owner` beneath the command badge at `<=760px`.

### Don't:

- **Don't** apply documentation tokens or Swiss grid rules to pika's incumbent session or dashboard interfaces without a separate design decision.
- **Don't** reintroduce `Docs Source Serif`, decorative kickers/eyebrows above headings, stat cards, or pill-shaped filter chips.
- **Don't** apply monospace fonts to table column headers, directory group labels, or category filter tabs; those are Aileron structural labels, not code.
- **Don't** treat synthesized sidecar tonal ramps as additional production palette tokens, or substitute static sidecar component previews for the live React routing, search, theme, and clipboard behavior.
