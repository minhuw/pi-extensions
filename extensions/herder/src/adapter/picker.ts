import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, type KeybindingsManager, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const optional = (description: string) => Type.Optional(Type.String({ description }));
export const FindingSchema = Type.Object({
	id: Type.String({ minLength: 1, pattern: "^\\S+$", description: "The finding's number in the table you posted, e.g. \"1\"" }),
	title: Type.String({ description: "Short imperative title, e.g. \"Delete the unused v1 plan parser\"" }),
	kind: optional("Category, e.g. deletion, duplicate, abstraction, compat"),
	effort: optional("Effort, e.g. S, M, L"),
	risk: optional("Risk, e.g. low, med, high"),
	confidence: optional("Confidence, e.g. HIGH, MED, LOW"),
	summary: Type.String({ description: "The 2-3 sentence plain-language explanation from the table" }),
	evidence: optional("file:line anchors"),
	recommended: Type.Optional(Type.Boolean({ description: "Preselect this finding; Enter alone accepts the recommended set" })),
	dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Ids of findings this one needs; selecting it selects them too" })),
});
export const PickParameters = Type.Object({
	title: Type.String({ minLength: 1, description: "Header, e.g. \"Simplify · standard · src/\"" }),
	findings: Type.Array(FindingSchema, { minItems: 1, maxItems: 99, description: "The findings in table order" }),
});
export type Finding = Static<typeof FindingSchema>;
export type PickParams = Static<typeof PickParameters>;
export interface PickDetails { selected: string[]; note?: string; cancelled: boolean; via: "picker" | "editor" }
/** Picker state shared across the picker instances of one interaction (each note edit reopens the picker). */
export interface PickState { title: string; findings: readonly Finding[]; selected: Set<string>; note?: string; cursor: number; offset: number }
export type PickerAction = "confirm" | "cancel" | "note";

export const VISIBLE_ROWS = 12;
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const HINTS = "↑↓ move · space/1-9 toggle · a all · n none · r recommended · e note · enter confirm · esc cancel";

export function validateFindings(findings: readonly Finding[]): void {
	const ids = new Set<string>();
	for (const { id } of findings) {
		if (!/^\S+$/.test(id)) throw new Error(`Finding id "${id}" must be a single word without spaces (its table number).`);
		if (ids.has(id)) throw new Error(`Duplicate finding id "${id}"; every finding needs a unique id (its table number).`);
		ids.add(id);
	}
	for (const { id, dependsOn = [] } of findings) {
		for (const dep of dependsOn) {
			if (dep === id) throw new Error(`Finding ${id} depends on itself.`);
			if (!ids.has(dep)) throw new Error(`Finding ${id} depends on unknown finding ${dep}.`);
		}
	}
}

/** `id` and everything it depends on ("needs"), or everything that depends on it ("neededBy"), transitively. */
export function closure(findings: readonly Finding[], id: string, direction: "needs" | "neededBy"): Set<string> {
	const next = (current: string) => direction === "needs"
		? findings.find((finding) => finding.id === current)?.dependsOn ?? []
		: findings.filter((finding) => finding.dependsOn?.includes(current)).map((finding) => finding.id);
	const seen = new Set<string>([id]);
	const queue = [id];
	while (queue.length) for (const other of next(queue.shift()!)) if (!seen.has(other)) { seen.add(other); queue.push(other); }
	return seen;
}

export const ordered = (findings: readonly Finding[], ids: ReadonlySet<string>) => findings.map((finding) => finding.id).filter((id) => ids.has(id));

export function recommendedSet(findings: readonly Finding[]): Set<string> {
	const selected = new Set<string>();
	for (const finding of findings) if (finding.recommended) for (const id of closure(findings, finding.id, "needs")) selected.add(id);
	return selected;
}

/** Toggles `id`: checking pulls in what it needs, unchecking drops what needs it. Reports the other findings that changed. */
export function toggle(findings: readonly Finding[], selected: ReadonlySet<string>, id: string): { selected: Set<string>; added: string[]; removed: string[] } {
	const next = new Set(selected);
	const checking = !selected.has(id);
	for (const other of closure(findings, id, checking ? "needs" : "neededBy")) {
		if (checking) next.add(other);
		else next.delete(other);
	}
	const changed = (from: ReadonlySet<string>, to: ReadonlySet<string>) => ordered(findings, to).filter((other) => other !== id && !from.has(other));
	return { selected: next, added: changed(selected, next), removed: changed(next, selected) };
}

export const initialState = (title: string, findings: readonly Finding[]): PickState => ({ title, findings, selected: recommendedSet(findings), cursor: 0, offset: 0 });

/** Single-line fields with every whitespace run, newlines included, collapsed to one space. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const needs = (finding: Finding) => finding.dependsOn?.length ? ` (needs ${finding.dependsOn.map(flat).join(", ")})` : "";
const meta = (finding: Finding) => [finding.kind, finding.effort, finding.risk, finding.confidence].map((cell) => cell && flat(cell));
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** Left and right on one line when both fit, otherwise each on its own line. */
function spread(left: string, right: string, width: number): string[] {
	const gap = width - visibleWidth(left) - visibleWidth(right) - 2;
	return gap >= 1 ? [` ${left}${" ".repeat(gap)}${right} `] : [` ${left}`, ` ${right}`];
}

/** `text` wrapped after `prefix`, continuation lines indented under it. */
function wrapAfter(prefix: string, text: string, width: number): string[] {
	const indent = visibleWidth(prefix);
	if (indent >= width / 2) return wrapTextWithAnsi(prefix + text, width);
	return wrapTextWithAnsi(text, width - indent).map((line, index) => (index ? " ".repeat(indent) : prefix) + line);
}

export class FindingsPicker implements Component {
	private cache: { width: number; lines: string[] } | undefined;
	private message = "";
	constructor(
		private readonly state: PickState,
		private readonly tui: { requestRender(): void },
		private readonly theme: Theme,
		private readonly keybindings: Pick<KeybindingsManager, "matches">,
		private readonly done: (action: PickerAction) => void,
	) {}

	handleInput(data: string): void {
		const { state, keybindings } = this;
		const count = state.findings.length;
		const digit = DIGITS.find((key) => matchesKey(data, key));
		this.message = "";
		if (keybindings.matches(data, "tui.select.confirm")) return this.done("confirm");
		if (keybindings.matches(data, "tui.select.cancel")) return this.done("cancel");
		if (matchesKey(data, "e")) return this.done("note");
		if (keybindings.matches(data, "tui.select.up")) state.cursor = (state.cursor - 1 + count) % count;
		else if (keybindings.matches(data, "tui.select.down")) state.cursor = (state.cursor + 1) % count;
		else if (matchesKey(data, Key.space)) this.toggle(state.cursor);
		else if (digit && Number(digit) <= count) this.toggle((state.cursor = Number(digit) - 1));
		else if (matchesKey(data, "a")) state.selected = new Set(state.findings.map((finding) => finding.id));
		else if (matchesKey(data, "n")) state.selected = new Set();
		else if (matchesKey(data, "r")) state.selected = recommendedSet(state.findings);
		else return;
		this.invalidate();
		this.tui.requestRender();
	}

	private toggle(index: number): void {
		const { selected, added, removed } = toggle(this.state.findings, this.state.selected, this.state.findings[index]!.id);
		this.state.selected = selected;
		this.message = [added.length ? `also selected ${added.map((id) => `#${id}`).join(", ")}` : "", removed.length ? `also cleared ${removed.map((id) => `#${id}`).join(", ")}` : ""].filter(Boolean).join("; ");
	}

	invalidate(): void { this.cache = undefined; }

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const w = Math.max(1, width);
		const { state, theme } = this;
		const { findings } = state;
		const rule = theme.fg("borderMuted", "─".repeat(w));
		const lines = [
			...spread(theme.fg("accent", theme.bold(flat(state.title))), theme.fg("muted", `${findings.length} findings · ${state.selected.size} selected`), w),
			rule,
		];
		// Keep the highlighted row inside the visible window.
		const rows = Math.min(VISIBLE_ROWS, findings.length);
		state.offset = Math.min(Math.max(state.offset, state.cursor - rows + 1), state.cursor, findings.length - rows);
		const columns = [0, 1, 2, 3].map((column) => Math.max(0, ...findings.map((finding) => visibleWidth(meta(finding)[column] ?? ""))));
		const metaWidth = columns.filter(Boolean).reduce((sum, column) => sum + column + 2, 0);
		const idWidth = Math.max(...findings.map((finding) => visibleWidth(flat(finding.id))));
		const lead = 7 + idWidth + 2;
		const showMeta = metaWidth > 0 && w - lead - metaWidth >= 16;
		const titleWidth = Math.max(1, w - lead - (showMeta ? metaWidth : 0));
		for (const [index, finding] of findings.entries()) {
			if (index < state.offset || index >= state.offset + rows) continue;
			const current = index === state.cursor;
			const checked = state.selected.has(finding.id);
			const color = current ? "accent" : "text";
			const box = checked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
			const title = pad(truncateToWidth(flat(finding.title) + needs(finding), titleWidth, "…"), titleWidth);
			const cells = showMeta ? meta(finding).map((cell, column) => columns[column] ? `  ${pad(cell ?? "", columns[column]!)}` : "").join("") : "";
			lines.push(truncateToWidth(`${theme.fg("accent", current ? " ▸ " : "   ")}${box} ${theme.fg(color, `${pad(flat(finding.id), idWidth)}  ${title}`)}${theme.fg("muted", cells)}`, w));
		}
		if (findings.length > rows) lines.push(theme.fg("dim", `   ${state.cursor + 1}/${findings.length}`));
		if (this.message) lines.push(...wrapAfter("   ", theme.fg("dim", this.message), w));
		const current = findings[state.cursor]!;
		const id = flat(current.id);
		// wrapTextWithAnsi splits embedded newlines, so multi-line summaries, evidence, and notes stay line-safe.
		lines.push(rule, ...wrapAfter(` ${theme.fg("accent", `#${id}`)}  `, current.summary, w));
		if (current.evidence) lines.push(...wrapAfter(" ".repeat(visibleWidth(` #${id}  `)), theme.fg("dim", current.evidence), w));
		if (state.note) lines.push(...wrapAfter(` ${theme.fg("muted", "note:")} `, state.note, w));
		lines.push(rule, ...wrapAfter(" ", theme.fg("dim", HINTS), w));
		const fitted = lines.map((line) => truncateToWidth(line, w));
		this.cache = { width, lines: fitted };
		return fitted;
	}
}

export function renderChecklist(title: string, findings: readonly Finding[], selected: ReadonlySet<string>, note?: string): string {
	const row = (finding: Finding) => {
		const cells = meta(finding).filter(Boolean).join(" · ");
		return `[${selected.has(finding.id) ? "x" : " "}] ${flat(finding.id)}  ${flat(finding.title)}${needs(finding)}${cells ? ` — ${cells}` : ""}`;
	};
	return [`# ${flat(title)}`, "# Mark the findings to resolve with [x]; leave [ ] to skip. A line starting with \"note:\" adds a note.", ...findings.map(row), `note:${note ? ` ${flat(note)}` : ""}`].join("\n");
}

/** Reads an edited checklist; unknown ids are ignored and checked findings pull in what they need. */
export function parseChecklist(text: string, findings: readonly Finding[]): { selected: string[]; note?: string } {
	const known = new Set(findings.map((finding) => finding.id));
	const selected = new Set<string>();
	const notes: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const row = /^\s*\[([ xX])\]\s*(\S+)/.exec(line);
		if (row && row[1] !== " " && known.has(row[2]!)) for (const id of closure(findings, row[2]!, "needs")) selected.add(id);
		const note = /^\s*note:(.*)$/i.exec(line)?.[1]!.trim();
		if (note) notes.push(note);
	}
	return { selected: ordered(findings, selected), ...(notes.length ? { note: notes.join(" ") } : {}) };
}

export function pickResult(total: number, details: PickDetails) {
	const ids = details.selected.map((id) => `#${id}`).join(", ");
	const summary = details.cancelled ? "The user cancelled the selection; start no run."
		: details.selected.length ? `Selected ${details.selected.length} of ${total}: ${ids}.`
		: `Selected none of ${total}; start no run.`;
	const note = !details.cancelled && details.note ? `\nNote: ${details.note}` : "";
	return { content: [{ type: "text" as const, text: summary + note }], details };
}

/** `promise`, or undefined once `signal` aborts: `ctx.ui.editor` takes no signal, so an abort must not wait for it. */
function unlessAborted<T>(promise: Promise<T | undefined>, signal: AbortSignal | undefined): Promise<T | undefined> {
	if (!signal) return promise;
	let onAbort = () => {};
	const aborted = new Promise<undefined>((resolve) => {
		onAbort = () => resolve(undefined);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

async function pickInTui(ctx: ExtensionContext, title: string, findings: readonly Finding[], signal: AbortSignal | undefined): Promise<PickDetails> {
	const cancelled: PickDetails = { selected: [], cancelled: true, via: "picker" };
	const state = initialState(title, findings);
	for (;;) {
		if (signal?.aborted) return cancelled;
		let onAbort: (() => void) | undefined;
		// A fresh component per interaction; the shared state carries the selection across note edits.
		const action = await ctx.ui.custom<PickerAction>((tui, theme, keybindings, done) => {
			onAbort = () => done("cancel");
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			return new FindingsPicker(state, tui, theme, keybindings, done);
		}).finally(() => { if (onAbort) signal?.removeEventListener("abort", onAbort); });
		if (signal?.aborted) return cancelled;
		if (action === "note") {
			const note = await unlessAborted(ctx.ui.editor("Note for the selected findings", state.note ?? ""), signal);
			if (note !== undefined) state.note = note.trim() || undefined;
			continue;
		}
		if (action !== "confirm") return cancelled;
		return { selected: ordered(findings, state.selected), ...(state.note ? { note: state.note } : {}), cancelled: false, via: "picker" };
	}
}

async function pickInEditor(ctx: ExtensionContext, title: string, findings: readonly Finding[], signal: AbortSignal | undefined): Promise<PickDetails> {
	const edited = signal?.aborted ? undefined : await unlessAborted(ctx.ui.editor(title, renderChecklist(title, findings, recommendedSet(findings))), signal);
	if (edited === undefined || signal?.aborted) return { selected: [], cancelled: true, via: "editor" };
	return { ...parseChecklist(edited, findings), cancelled: false, via: "editor" };
}

export function registerPickerTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "herder_pick_findings", label: "Herder Pick Findings", executionMode: "sequential",
		description: "Let the user pick which audit findings to resolve. Post the findings table and explanations in chat first, then pass the same findings in table order; recommended ones start selected. Returns the selected ids and an optional note: build the Herder run from exactly that selection, and start no run if none is selected or the user cancels. Needs no run.",
		parameters: PickParameters,
		async execute(_id, params, signal, _update, ctx) {
			validateFindings(params.findings);
			if (ctx.mode === "tui") return pickResult(params.findings.length, await pickInTui(ctx, params.title, params.findings, signal));
			if (ctx.hasUI) return pickResult(params.findings.length, await pickInEditor(ctx, params.title, params.findings, signal));
			throw new Error("herder_pick_findings needs an interactive session; ask the user in chat which findings to resolve.");
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.findings) ? args.findings.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold("pick findings: ")) + theme.fg("muted", `${args.title ?? ""} (${count})`), 0, 0);
		},
		renderResult(result, _options, theme, context) {
			const first = result.content[0];
			const line = (first?.type === "text" ? first.text : "").split("\n")[0]!;
			// Pi renders thrown errors here too, without details.
			const color = context.isError ? "error" : (result.details as PickDetails | undefined)?.cancelled ? "warning" : "success";
			return new Text(theme.fg(color, line), 0, 0);
		},
	});
}
