// agents-md's review gate: a built-in `edit` or `write` of an agent context file (AGENTS.md, CLAUDE.md, ...) in a
// top-level interactive session waits until the user has seen its diff and the lint findings it adds, and applies only
// on their Apply. Children (subagents, Herder steps, dreams) and sessions without a UI pass; while the user is away
// (a selfdrive standing approval exists) the change is refused so it waits for their review. `bash` is not gated.
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { structuredPatch } from "diff";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { isContextFile, lintContextFile, newFindings, repositoryContextFiles, type LintFinding } from "./lint.ts";
import { promptReviewDialog } from "./review-ui.ts";

export const SESSION_LINK_TYPE = "pi-extensions.session-link";
/** selfdrive publishes its grants here while the user is away; read it, never import selfdrive. */
export const STANDING_APPROVAL_KEY = Symbol.for("pi-extensions.standing-approval");

export const CHOICES = { apply: "Apply", reject: "Reject", note: "Reject with a note" } as const;
/** The diff lines (hunk headers and body) the dialog shows at most. */
export const MAX_DIFF_LINES = 40;
/** The new findings the dialog lists at most. */
export const MAX_FINDINGS = 10;
const MAX_LINE_CHARS = 300;
const CONTEXT_LINES = 3;

export const reasons = {
	rejected: (path: string, note?: string) => {
		const trimmed = note?.trim().replace(/[\s.]+$/, "");
		return `The user rejected this change to ${path}${trimmed ? `: ${trimmed}` : ""}. Do not retry it unchanged.`;
	},
	away: (path: string) =>
		`The user is away (self-driving mode), and changes to ${path} wait for their review. Do not make this change now; describe it in your report instead.`,
	inexact: (path: string, index: number) =>
		`edits[${index}].oldText matches ${path} only after ignoring trailing whitespace or Unicode quotes, dashes, or spaces, and the user reviews the exact result of every change to it. Read the file and retry with its exact text.`,
};

// ---- Sessions ----

/**
 * A child session: subagents, Herder steps, and dreams. Live children bind extensions with no mode (Pi runs them as
 * print), and persisted children carry a `pi-extensions.session-link` entry; `parentSession` cannot tell, forks set it.
 */
export function isChildSession(ctx: Pick<ExtensionContext, "mode" | "sessionManager">): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return true;
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	return entries.some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

/** Whether the user is away: some session of this process holds a selfdrive standing approval. */
export function userAway(): boolean {
	const registry = (globalThis as Record<symbol, unknown>)[STANDING_APPROVAL_KEY] as { grants?: unknown } | undefined;
	return registry?.grants instanceof Map && registry.grants.size > 0;
}

// ---- Paths (as selfdrive's guard resolves them; extensions do not import each other) ----

/** The deepest existing ancestor's real path followed by the missing rest, following a dangling symlink. */
export function canonical(path: string, seen = new Set<string>()): string {
	const absolute = resolve(path);
	const trailing: string[] = [];
	let current = absolute;
	for (;;) {
		try {
			const real = realpathSync.native(current);
			return trailing.length > 0 ? join(real, ...trailing) : real;
		} catch {
			try {
				if (lstatSync(current).isSymbolicLink() && !seen.has(current)) {
					seen.add(current);
					const target = canonical(resolve(dirname(current), readlinkSync(current)), seen);
					return trailing.length > 0 ? join(target, ...trailing) : target;
				}
			} catch {
				// Missing: try the parent.
			}
		}
		const parent = dirname(current);
		if (parent === current) return absolute;
		trailing.unshift(basename(current));
		current = parent;
	}
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * A `write`/`edit` path resolved the way Pi's file tools resolve it (Unicode spaces become spaces, one leading `@` is
 * dropped, `~` is expanded, a `file://` URL becomes its path), then canonicalized. Undefined when Pi could not resolve it.
 */
export function resolveToolPath(raw: string, cwd: string): string | undefined {
	let path = raw.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	else if (/^file:\/\//.test(path)) {
		try {
			path = fileURLToPath(path);
		} catch {
			return undefined;
		}
	}
	return canonical(resolve(canonical(cwd), path));
}

/** `file` relative to `root` when inside it, else absolute. */
export function displayPath(root: string, file: string): string {
	const rel = relative(root, file);
	return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? file : rel;
}

/** The repository root lint resolves against for `file`: from its nearest existing directory. */
export function rootFor(file: string): string {
	let dir = dirname(file);
	while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
	try {
		return repositoryContextFiles(dir).root;
	} catch {
		return dirname(file);
	}
}

// ---- Edits ----

const normalizeToLF = (text: string): string => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const stripBom = (text: string): string => (text.startsWith("\uFEFF") ? text.slice(1) : text);

/** Pi's edit tool falls back to this normalization when an oldText does not match exactly. */
const fuzzy = (text: string): string =>
	text.normalize("NFKC").split("\n").map((line) => line.trimEnd()).join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, "\"")
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

export type EditOutcome =
	| { kind: "applied"; text: string }
	/** The edit tool will fail on its own (missing, repeated, empty, overlapping, or no-op edits). */
	| { kind: "invalid" }
	/** edits[index] matches only through the edit tool's fuzzy fallback, whose result the gate cannot show exactly. */
	| { kind: "inexact"; index: number };

/** `edits` applied to `current` (LF-normalized, without BOM) the way the edit tool applies exact matches. */
export function applyEdits(current: string, edits: readonly { oldText: string; newText: string }[]): EditOutcome {
	if (edits.length === 0) return { kind: "invalid" };
	const matches: { start: number; end: number; newText: string }[] = [];
	for (const [index, edit] of edits.entries()) {
		const oldText = normalizeToLF(edit.oldText);
		if (oldText.length === 0) return { kind: "invalid" };
		const count = occurrences(current, oldText);
		if (count === 1) {
			const start = current.indexOf(oldText);
			matches.push({ start, end: start + oldText.length, newText: normalizeToLF(edit.newText) });
			continue;
		}
		if (count === 0 && fuzzy(current).includes(fuzzy(oldText))) return { kind: "inexact", index };
		return { kind: "invalid" };
	}
	matches.sort((a, b) => a.start - b.start);
	for (let i = 1; i < matches.length; i++) if (matches[i - 1]!.end > matches[i]!.start) return { kind: "invalid" };
	let text = current;
	for (const match of [...matches].reverse()) text = text.slice(0, match.start) + match.newText + text.slice(match.end);
	return text === current ? { kind: "invalid" } : { kind: "applied", text };
}

// ---- Diff ----

const lineText = (t: string): string => {
	const lf = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return lf === "" ? "" : lf.endsWith("\n") ? lf : `${lf}\n`;
};

/** A unified diff of `before` → `after` (hunks only, without file headers), or [] when the lines are the same. */
export function unifiedDiff(before: string, after: string, context = CONTEXT_LINES): string[] {
	const oldStr = lineText(before);
	const newStr = lineText(after);
	if (oldStr === newStr) return [];
	const patch = structuredPatch("", "", oldStr, newStr, undefined, undefined, { context });
	const out: string[] = [];
	for (const hunk of patch.hunks) {
		const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
		const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart;
		out.push(`@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`);
		for (const line of hunk.lines) {
			if (line !== "\\ No newline at end of file") out.push(line);
		}
	}
	return out;
}

/** At most `max` diff lines, each at most a few hundred characters, with a count of what was left out. */
export function truncateDiff(lines: string[], max = MAX_DIFF_LINES): string[] {
	const clip = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line);
	if (lines.length <= max) return lines.map(clip);
	const rest = lines.slice(max);
	const added = rest.filter((line) => line.startsWith("+")).length;
	const removed = rest.filter((line) => line.startsWith("-")).length;
	return [...lines.slice(0, max).map(clip), `… ${rest.length} more diff lines (${added} added, ${removed} removed) not shown`];
}

// ---- Review ----

export const formatFinding = (finding: LintFinding): string => (finding.line === undefined ? finding.message : `line ${finding.line}: ${finding.message}`);

/** The findings `after` adds to `before`, or the error lint threw. */
export function addedFindings(before: string, after: string, file: string, root: string): { findings: LintFinding[] } | { error: string } {
	try {
		return { findings: newFindings(lintContextFile(before, { file, root }), lintContextFile(after, { file, root })) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** The dialog's text: what changes, its diff, and the lint findings it adds. */
export function reviewText(path: string, tool: "edit" | "write", before: string, after: string, added: ReturnType<typeof addedFindings>, existed: boolean): string {
	const action = !existed ? "creates" : tool === "write" ? "rewrites" : "edits";
	const diff = unifiedDiff(before, after);
	const lines = [`Review this change to ${path}: the agent's ${tool} ${action} it.`, ""];
	if (diff.length > 0) lines.push(`--- a/${path}`, `+++ b/${path}`, ...truncateDiff(diff));
	else lines.push("(Only line endings or the final newline change.)");
	lines.push("");
	if ("error" in added) lines.push(`Lint could not run: ${added.error}`);
	else if (added.findings.length === 0) lines.push("No new lint findings.");
	else {
		lines.push(`New lint findings (${added.findings.length}):`, ...added.findings.slice(0, MAX_FINDINGS).map((finding) => `- ${formatFinding(finding)}`));
		if (added.findings.length > MAX_FINDINGS) lines.push(`- … and ${added.findings.length - MAX_FINDINGS} more`);
	}
	return lines.join("\n");
}

/** The proposed change: the file's current and new text, or undefined when the gate stands aside. */
type Proposal = { kind: "change"; before: string; after: string; existed: boolean } | { kind: "allow" } | { kind: "block"; reason: string };

function propose(tool: "edit" | "write", input: Record<string, unknown>, file: string, path: string): Proposal {
	let current: string | undefined;
	try {
		current = statSync(file).isFile() ? stripBom(normalizeToLF(readFileSync(file, "utf8"))) : undefined;
	} catch {
		current = undefined;
	}
	if (tool === "write") {
		if (typeof input.content !== "string") return { kind: "allow" };
		const after = normalizeToLF(input.content);
		if (current !== undefined && after === current) return { kind: "allow" };
		return { kind: "change", before: current ?? "", after, existed: current !== undefined };
	}
	if (current === undefined || !Array.isArray(input.edits)) return { kind: "allow" };
	const edits = input.edits.filter((edit): edit is { oldText: string; newText: string } =>
		typeof edit?.oldText === "string" && typeof edit?.newText === "string");
	if (edits.length !== input.edits.length) return { kind: "allow" };
	const outcome = applyEdits(current, edits);
	if (outcome.kind === "invalid") return { kind: "allow" };
	if (outcome.kind === "inexact") return { kind: "block", reason: reasons.inexact(path, outcome.index) };
	return { kind: "change", before: current, after: outcome.text, existed: true };
}

/** The gate's verdict on one tool call: undefined lets it run. */
export async function reviewToolCall(toolName: string, input: unknown, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
	if (toolName !== "edit" && toolName !== "write") return undefined;
	if (!ctx.hasUI || isChildSession(ctx)) return undefined;
	const args = (input ?? {}) as Record<string, unknown>;
	const raw = typeof args.path === "string" ? args.path : undefined;
	const file = raw?.trim() ? resolveToolPath(raw, ctx.cwd) : undefined;
	// The written file, or the name the agent wrote through: an AGENTS.md symlink makes its target a context file.
	if (!file || !(isContextFile(file) || isContextFile(basename(raw!.trim().replace(/^@/, ""))))) return undefined;

	const root = rootFor(file);
	const path = displayPath(root, file);
	if (userAway()) return { block: true, reason: reasons.away(path) };

	const proposal = propose(toolName, args, file, path);
	if (proposal.kind === "allow") return undefined;
	if (proposal.kind === "block") return { block: true, reason: proposal.reason };

	const added = addedFindings(proposal.before, proposal.after, file, root);
	const options = { signal: ctx.signal };
	let choice: string | undefined;
	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
		choice = await promptReviewDialog(
			ctx,
			{ path, tool: toolName, before: proposal.before, after: proposal.after, existed: proposal.existed, added },
			ctx.signal,
		);
	} else {
		const text = reviewText(path, toolName, proposal.before, proposal.after, added, proposal.existed);
		try {
			choice = await ctx.ui.select(text, [CHOICES.apply, CHOICES.reject, CHOICES.note], options);
		} catch {
			choice = undefined;
		}
	}
	if (choice === CHOICES.apply && !ctx.signal?.aborted) return undefined;
	let note: string | undefined;
	if (choice === CHOICES.note && !ctx.signal?.aborted) {
		try {
			note = await ctx.ui.input(`Why reject the change to ${path}?`, "a note for the agent", options);
		} catch {
			note = undefined;
		}
	}
	return { block: true, reason: reasons.rejected(path, note) };
}

/** Registers the review gate on `tool_call`. */
export function registerGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => reviewToolCall(event.toolName, event.input, ctx));
}
