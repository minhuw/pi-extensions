// agents-md: AGENTS.md (and CLAUDE.md, ...) is the repository's reviewed, versioned rule store. The review gate
// (gate.ts) shows the user every edit/write of one before it applies; `agents_md_lint` checks them offline (lint.ts).
import { readFileSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { displayPath, formatFinding, registerGate, resolveToolPath, rootFor } from "./gate.ts";
import { lintContextFile, repositoryContextFiles, type LintFinding } from "./lint.ts";

export interface FileReport {
	/** Relative to the repository root when inside it, else absolute. */
	path: string;
	findings: LintFinding[];
	/** Why the file could not be read; it has no findings then. */
	error?: string;
}
export interface LintDetails {
	root: string;
	files: FileReport[];
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Lints `path` (resolved against `cwd`), or every context file of the repository holding `cwd`. */
export function lintReport(cwd: string, path?: string): LintDetails {
	let root: string;
	let files: string[];
	const raw = path?.trim();
	if (raw) {
		const file = resolveToolPath(raw, cwd);
		let isFile = false;
		try { isFile = file !== undefined && statSync(file).isFile(); } catch {}
		if (!file || !isFile) throw new Error(`${raw} is not a file.`);
		root = rootFor(file);
		files = [file];
	} else {
		({ root, files } = repositoryContextFiles(cwd));
	}
	return {
		root,
		files: files.map((file): FileReport => {
			const shown = displayPath(root, file);
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch (error) {
				return { path: shown, findings: [], error: error instanceof Error ? error.message : String(error) };
			}
			return { path: shown, findings: lintContextFile(text, { file, root }) };
		}),
	};
}

/** The tool's text: per file, its path and findings with line numbers, or "no findings". */
export function formatReport(details: LintDetails): string {
	if (details.files.length === 0) return `No context files (AGENTS.md, CLAUDE.md, ...) in ${details.root}.`;
	return details.files.map((file) => {
		if (file.error) return `${file.path}: could not be read (${file.error})`;
		if (file.findings.length === 0) return `${file.path}: no findings`;
		return [`${file.path}: ${plural(file.findings.length, "finding")}`, ...file.findings.map((finding) => `- ${formatFinding(finding)}`)].join("\n");
	}).join("\n");
}

export function registerLintTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "agents_md_lint",
		label: "AGENTS.md Lint",
		description: "Lint the repository's agent context files (AGENTS.md, CLAUDE.md, ...) offline: paths, `npm run` scripts, and links that name nothing, duplicate lines, and files past the size budget. Without path, lints every context file of the repository; with path, that file. Returns each file's findings with line numbers, or \"no findings\".",
		promptSnippet: "Check the repository's AGENTS.md files for dead paths, scripts, links, duplicates, and size",
		promptGuidelines: [
			"AGENTS.md holds the standing rules every session in this repository must follow: commands, conventions that differ from defaults, pitfalls, do-not-touch areas. When the user states such a rule for the repository ('always', 'never', 'in this repo'), add it to AGENTS.md with edit rather than to memory; the user reviews every change to an AGENTS.md file.",
			"Keep AGENTS.md small and true: one line per rule, nothing the code already shows, no task-specific decisions; run agents_md_lint after changing it and fix what it reports.",
		],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "A context file to lint, relative to the working directory; leave out to lint every one in the repository" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const details = lintReport(ctx.cwd, params.path);
			return { content: [{ type: "text" as const, text: formatReport(details) }], details };
		},
		renderCall(args, theme) {
			const what = typeof args.path === "string" && args.path.trim() ? args.path : "all context files";
			return new Text(`${theme.fg("toolTitle", theme.bold("agents_md_lint "))}${theme.fg("muted", what)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (isPartial) return new Text(theme.fg("dim", "linting…"), 0, 0);
			if (context.isError) return new Text(theme.fg("error", text), 0, 0);
			const files = (result.details as LintDetails | undefined)?.files ?? [];
			const total = files.reduce((sum, file) => sum + file.findings.length, 0);
			const flagged = files.filter((file) => file.findings.length > 0 || file.error).length;
			const summary = files.length === 0
				? theme.fg("dim", "no context files")
				: flagged === 0
					? theme.fg("success", `${plural(files.length, "file")}, no findings`)
					: theme.fg("warning", `${plural(total, "finding")} in ${flagged} of ${plural(files.length, "file")}`);
			return new Text(expanded ? `${summary}\n${theme.fg("dim", text)}` : summary, 0, 0);
		},
	});
}

/** The review gate for edits and writes of context files, and the `agents_md_lint` tool. */
export default function agentsMdExtension(pi: ExtensionAPI): void {
	registerGate(pi);
	registerLintTool(pi);
}
