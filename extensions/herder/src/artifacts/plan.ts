import type { Gap } from "../types.ts";
import { criterionId, fences, stripBom } from "./markdown.ts";

export interface PlanTask { id: string; criteria: string[]; text: string; line: number }

const TASK = /^[-*]\s+\[[ xX]\]\s+(T\d+)\s+\(\s*(AC-\d+(?:\s*,\s*AC-\d+)*)\s*\)\s+(\S.*?)\s*$/;
const CONVERGENCE = /^##\s+Convergence\s+(\d+)\s*$/;

/** Task lines `- [ ] T<n> (AC-<n>[, AC-<n>]) <text>` (also `[x]`) outside code fences; every other line is ignored. */
export function parsePlanTasks(text: string): PlanTask[] {
	const tasks: PlanTask[] = [];
	const lines = stripBom(text).split(/\r?\n/);
	const { fenced } = fences(lines);
	for (const [i, line] of lines.entries()) {
		const match = !fenced[i] && TASK.exec(line);
		if (match) tasks.push({ id: match[1], criteria: [...new Set(match[2].split(/\s*,\s*/).map((id) => criterionId(id)!))], text: match[3], line: i + 1 });
	}
	return tasks;
}

/**
 * Appends `## Convergence N` after the highest existing N; the original text is a byte-for-byte prefix of the result.
 * An unclosed code fence is closed first, so the new section is never swallowed by it.
 */
export function appendConvergence(text: string, gaps: readonly Gap[]): { text: string; n: number } {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const source = stripBom(text).split(/\r?\n/);
	// Numbering counts fenced headings too, so it keeps increasing however the file is fenced.
	const n = Math.max(0, ...source.map((line) => Number(CONVERGENCE.exec(line)?.[1] ?? 0))) + 1;
	const { unclosed } = fences(source);
	const separator = unclosed ? (text.endsWith("\n") ? "" : eol)
		: !text || /\r?\n\r?\n$/.test(text) ? "" : text.endsWith("\n") ? eol : eol + eol;
	// Collapsing whitespace keeps one line per gap, and only `AC-<n>` ids go in the parentheses, so verifier output can
	// never start a heading or task line.
	const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
	const lines = gaps.length
		? gaps.map((gap) => {
			const ids = [...new Set(gap.criteria.map((id) => criterionId(id)).filter((id) => id !== undefined))];
			const other = gap.criteria.filter((id) => !criterionId(id) && oneLine(id)).map((id) => JSON.stringify(oneLine(id)));
			return `- ${oneLine(gap.kind)}${ids.length ? ` (${ids.join(", ")})` : ""}: ${oneLine(gap.text)}${other.length ? ` (other criteria: ${other.join(", ")})` : ""}`;
		})
		: ["- No gaps."];
	return { text: text + separator + [...(unclosed ? [unclosed.marker, ""] : []), `## Convergence ${n}`, "", ...lines, ""].join(eol), n };
}
