import { createHash } from "node:crypto";
import { DEFAULT_CHECK_TIMEOUT_MS, DEFAULT_FIX_ATTEMPTS } from "../config.ts";
import type { CheckSpec } from "../types.ts";
import { criterionId, fences, stripBom } from "./markdown.ts";

export interface Criterion { id: string; text: string; verify: { kind: "check"; checks: string[] } | { kind: "judge"; rubric: string } }
export interface Goal { title: string; intent: string; criteria: Criterion[]; checks: CheckSpec[]; constraints: string[]; outOfScope: string[]; budget: { maxAgents?: number; maxFixAttempts?: number } }

export class GoalError extends Error {
	readonly problems: string[];
	constructor(problems: string[]) { super(problems.join("\n")); this.name = "GoalError"; this.problems = problems; }
}

type Section = "intent" | "criteria" | "checks" | "constraints" | "outOfScope" | "budget";
interface Line { n: number; text: string; fenced?: boolean }

const SECTIONS: Record<string, Section> = {
	intent: "intent", "acceptance criteria": "criteria", criteria: "criteria", checks: "checks",
	constraints: "constraints", "out of scope": "outOfScope", budget: "budget",
};
const CHECK_ID = /^[a-z0-9][a-z0-9-]*$/;
const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$/;
const CRITERION_START = /^[*_]{0,2}(AC-\d+)\s*[:.)]?[*_]{0,2}(?:\s*[:.)\u2014\u2013-])?\s*(.*)$/i;
const VERIFY = /[*_]*\bverify[*_]*\s*:[*_]*/gi;
const BUDGET_KEYS: Record<string, keyof Goal["budget"]> = { max_agents: "maxAgents", max_fix_attempts: "maxFixAttempts" };
const QUOTES: Record<string, string> = { '"': '"', "'": "'", "`": "`", "\u201c": "\u201d", "\u2018": "\u2019" };
const VERIFY_HINT = "`check:<id>[, check:<id>]` or `judge — rubric: \"…\"`";

/** Parses and validates goal.md; throws `GoalError` listing every problem. */
export function parseGoal(text: string): Goal {
	const problems: string[] = [];
	const structure: string[] = [];
	const sections = new Map<Section, Line[]>();
	const headings = new Map<Section, number>();
	let title: Line | undefined;
	let current: Line[] | undefined;
	const source = stripComments(stripBom(text)).split(/\r?\n/);
	const { fenced, unclosed } = fences(source);
	if (unclosed) structure.push(`line ${unclosed.n}: code fence \`${unclosed.marker}\` is never closed`);
	for (const [i, raw] of source.entries()) {
		const line = { n: i + 1, text: raw.trimEnd(), fenced: fenced[i] };
		const goal = !line.fenced && /^#\s+goal\s*[:\u2014\u2013-]\s*(.*)$/i.exec(line.text);
		if (goal && !title) { title = { n: line.n, text: goal[1].trim() }; current = undefined; continue; }
		const heading = !line.fenced && /^#{1,6}\s+(.*?)[\s#]*$/.exec(line.text);
		if (heading) {
			const name = heading[1].toLowerCase().replace(/[-_\s]+/g, " ").replace(/:$/, "");
			const section = Object.hasOwn(SECTIONS, name) ? SECTIONS[name] : undefined;
			const first = section && headings.get(section);
			if (first) structure.push(`line ${line.n}: duplicate \`${line.text.trim()}\` section (first on line ${first}); merge them into one`);
			else if (section) { headings.set(section, line.n); sections.set(section, []); }
			current = first ? undefined : section && sections.get(section);
			continue;
		}
		current?.push(line);
	}
	const lines = (section: Section) => sections.get(section) ?? [];

	if (!title) problems.push("missing title: the first heading must be `# Goal: <one line>`");
	else if (!title.text) problems.push(`line ${title.n}: the \`# Goal:\` title is empty`);
	problems.push(...structure);
	const criteria = parseCriteria(lines("criteria"), problems);
	const { checks, declared } = parseChecks(lines("checks"), problems);
	for (const { criterion, n } of criteria) {
		if (criterion.verify.kind !== "check") continue;
		for (const id of criterion.verify.checks) {
			if (!declared.has(id)) problems.push(`line ${n}: ${criterion.id} references unknown check "${id}" (declared: ${[...declared].join(", ") || "none"})`);
		}
	}
	const budget = parseBudget(lines("budget"), problems);
	if (problems.length) throw new GoalError(problems);
	return {
		title: title!.text,
		intent: lines("intent").map((line) => line.text).join("\n").trim(),
		criteria: criteria.map((entry) => entry.criterion),
		checks,
		constraints: listItems(lines("constraints")),
		outOfScope: listItems(lines("outOfScope")),
		budget,
	};
}

/**
 * SHA-256 hex of the text with a leading BOM removed, trailing whitespace (including `\r`) removed from each line, and
 * trailing blank lines dropped. An editor adding or dropping the BOM on save does not change the goal.
 */
export function hashGoal(text: string): string {
	const normalized = stripBom(text).split("\n").map((line) => line.replace(/[ \t\r\f\v]+$/, "")).join("\n").replace(/\n+$/, "");
	return createHash("sha256").update(normalized).digest("hex");
}

export function goalDraft(title: string): string {
	return `# Goal: ${title.replace(/\s+/g, " ").trim()}

## Intent
<!-- Up to 5 lines: why this change is wanted and for whom. -->

## Acceptance criteria
<!--
One bullet per criterion, each ending with how it is verified:
  - AC-1: WHEN <trigger> THE SYSTEM SHALL <observable outcome>. verify: check:<id>
  - AC-2: <criterion>. verify: judge — rubric: "<binary statement the verifier can confirm>"
Rules:
- Write criteria in EARS form (WHEN … THE SYSTEM SHALL …); each states one observable, testable outcome.
- Map every criterion to one or more checks (verify: check:a, check:b) or to judge with a yes/no rubric.
- Prefer checks: use judge only for what no command can decide.
-->

## Checks
<!--
Shell commands run at the repository root; exit code 0 means pass.
id: lowercase letters, digits, and hyphens. timeout: 30s, 10m, 1h, or 1h30m (empty means ${DEFAULT_CHECK_TIMEOUT_MS / 60_000}m).
integrate: yes runs the check before every integration; no runs it at verification only.
-->
| id | command | timeout | integrate |
| --- | --- | --- | --- |

## Constraints
<!-- One bullet per thing that must not change or must hold throughout. -->

## Out of scope
<!-- One bullet per related change that must not be made. -->

## Budget
<!-- Optional. max_agents: <n> caps agent starts for the run; max_fix_attempts caps fix loops per task. -->
max_fix_attempts: ${DEFAULT_FIX_ATTEMPTS}
`;
}

/** `30s`, `10m`, `1h`, or compounds such as `1h30m` to milliseconds. */
export function parseDuration(text: string): number {
	const match = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i.exec(text.trim());
	const ms = match ? ((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1000 : 0;
	if (!(ms > 0)) throw new Error(`invalid timeout "${text.trim()}"; use a duration such as 30s, 10m, 1h, or 1h30m`);
	return ms;
}

// Blanks out HTML comments but keeps their newlines, so line numbers in problems stay accurate.
function stripComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, ""));
}

function parseCriteria(lines: Line[], problems: string[]): { criterion: Criterion; n: number }[] {
	const items: Line[] = [];
	let open = false;
	for (const line of lines) {
		if (!line.text.trim() || line.fenced) { open = false; continue; }
		const bullet = BULLET.exec(line.text);
		const body = bullet ? bullet[2] : line.text.trim();
		const continues = open && (!bullet || bullet[1].length > 0) && !CRITERION_START.test(body);
		if (continues) items[items.length - 1].text += ` ${body}`;
		else if (bullet || CRITERION_START.test(body)) { items.push({ n: line.n, text: body }); open = true; }
	}
	if (!items.length) {
		problems.push("no acceptance criteria: add `- AC-1: <criterion>. verify: check:<id>` lines under `## Acceptance criteria`");
		return [];
	}
	const seen = new Map<string, number>();
	const criteria: { criterion: Criterion; n: number }[] = [];
	for (const { n, text } of items) {
		const start = CRITERION_START.exec(text);
		if (!start) { problems.push(`line ${n}: a criterion must start with an id such as \`AC-1:\``); continue; }
		const id = criterionId(start[1])!;
		const first = seen.get(id);
		if (first !== undefined) { problems.push(`line ${n}: duplicate criterion id ${id} (first on line ${first})`); continue; }
		seen.set(id, n);
		// The last marker wins, so the criterion text itself may say "verify:".
		const marker = [...start[2].matchAll(VERIFY)].pop();
		if (!marker) { problems.push(`line ${n}: ${id} has no \`verify:\`; end it with \`verify: check:<id>\` or \`verify: judge — rubric: "…"\``); continue; }
		let body = start[2].slice(0, marker.index!).trim();
		let spec = start[2].slice(marker.index + marker[0].length).trim();
		if (/[([]$/.test(body)) { body = body.slice(0, -1).trim(); spec = spec.replace(/[)\]]$/, "").trim(); }
		body = body.replace(/[\s*_,;\u2014\u2013-]+$/, "");
		const verify = parseVerify(spec);
		if (typeof verify === "string") problems.push(`line ${n}: ${id}: ${verify}`);
		else criteria.push({ criterion: { id, text: body, verify }, n });
	}
	return criteria;
}

function parseVerify(spec: string): Criterion["verify"] | string {
	const judge = /^`?judge\b`?(.*)$/i.exec(spec);
	if (judge) {
		const rubric = /^[\s,;:(\u2014\u2013-]*rubric\s*:\s*(.*)$/i.exec(judge[1]);
		const value = rubric ? unquote(rubric[1].trim()) : "";
		return value ? { kind: "judge", rubric: value } : "a judge criterion needs a non-empty rubric: `verify: judge — rubric: \"<binary statement>\"`";
	}
	const tokens = spec.replace(/`/g, "").replace(/\bcheck\s*:\s*/gi, "check:").split(/[\s,;+]+/).filter((token) => token && !/^and$/i.test(token));
	const checks = tokens.map((token) => /^check:([^\s.,;]+)[.,;]*$/i.exec(token)?.[1]);
	if (!checks.length || checks.some((id) => id === undefined)) return `\`verify:\` must be ${VERIFY_HINT}, got "${spec}"`;
	return { kind: "check", checks: [...new Set(checks as string[])] };
}

function unquote(text: string): string {
	const close = QUOTES[text[0]];
	if (close) {
		const end = text.lastIndexOf(close);
		if (end > 0) return text.slice(1, end).trim();
	}
	return text;
}

/** `declared` also holds ids of rows with other problems, so references to them are not reported twice. */
function parseChecks(lines: Line[], problems: string[]): { checks: CheckSpec[]; declared: Set<string> } {
	const rows = lines.filter((line) => !line.fenced && line.text.trimStart().startsWith("|"));
	const checks: CheckSpec[] = [];
	const declared = new Set<string>();
	if (!rows.length) return { checks, declared };
	const normalize = (text: string) => splitRow(text).map((cell) => cell.toLowerCase().replace(/[^a-z]/g, "")).join("|");
	const separator = (row?: Line) => !!row && /^[\s|:-]*$/.test(row.text) && row.text.includes("-");
	const header = normalize(rows[0].text).split("|");
	const column = (name: string) => header.indexOf(name);
	const [id, command, timeout, integrate] = ["id", "command", "timeout", "integrate"].map(column);
	if (id < 0 || command < 0) {
		problems.push(`line ${rows[0].n}: the Checks table header must include \`id\` and \`command\` columns (expected \`| id | command | timeout | integrate |\`)`);
		return { checks, declared };
	}
	const seen = new Map<string, number>();
	for (const [i, row] of rows.entries()) {
		if (i === 0 || separator(row)) continue;
		const next = rows[i + 1];
		if ((separator(next) && next.n === row.n + 1) || normalize(row.text) === header.join("|")) {
			problems.push(`line ${row.n}: second table header in Checks (the table starts on line ${rows[0].n}); keep every check in one table`);
			continue;
		}
		const cells = splitRow(row.text).map(stripCode);
		const cell = (index: number) => (index < 0 ? "" : cells[index] ?? "");
		if (cells.every((value) => !value)) continue;
		const check = { id: cell(id), command: cell(command), timeoutMs: DEFAULT_CHECK_TIMEOUT_MS, integrate: false };
		const before = problems.length;
		const first = seen.get(check.id);
		if (check.id) declared.add(check.id);
		if (!CHECK_ID.test(check.id)) problems.push(`line ${row.n}: check id "${check.id}" must match /^[a-z0-9][a-z0-9-]*$/ (lowercase letters, digits, hyphens)`);
		else if (first !== undefined) problems.push(`line ${row.n}: duplicate check id "${check.id}" (first on line ${first})`);
		else seen.set(check.id, row.n);
		if (!check.command) problems.push(`line ${row.n}: check ${check.id} has an empty command`);
		if (cell(timeout)) {
			try { check.timeoutMs = parseDuration(cell(timeout)); } catch (error) { problems.push(`line ${row.n}: check ${check.id}: ${(error as Error).message}`); }
		}
		const flag = cell(integrate).toLowerCase();
		if (/^(yes|y|true)$/.test(flag)) check.integrate = true;
		else if (!/^(no|n|false|)$/.test(flag)) problems.push(`line ${row.n}: check ${check.id}: integrate must be yes or no, got "${cell(integrate)}"`);
		if (problems.length === before) checks.push(check);
	}
	return { checks, declared };
}

// Splits a Markdown table row on unescaped pipes; `\|` becomes a literal pipe inside a cell.
function splitRow(text: string): string[] {
	const cells: string[] = [];
	let cell = "";
	const row = text.trim();
	for (let i = 0; i < row.length; i++) {
		if (row[i] === "\\" && row[i + 1] === "|") { cell += "|"; i++; }
		else if (row[i] === "|") { cells.push(cell); cell = ""; }
		else cell += row[i];
	}
	cells.push(cell);
	if (row.startsWith("|")) cells.shift();
	if (row.endsWith("|") && !row.endsWith("\\|")) cells.pop();
	return cells.map((value) => value.trim());
}

function stripCode(cell: string): string {
	return /^`[^`]*`$/.test(cell) ? cell.slice(1, -1).trim() : cell;
}

function parseBudget(lines: Line[], problems: string[]): Goal["budget"] {
	const budget: Goal["budget"] = {};
	const allowed = `allowed keys: ${Object.keys(BUDGET_KEYS).join(", ")}`;
	for (const line of lines) {
		if (line.fenced || !line.text.trim()) continue;
		const text = (BULLET.exec(line.text)?.[2] ?? line.text).replace(/[`*]/g, "").trim();
		const entry = /^([a-z][\w -]*?)\s*[:=]\s*(.*)$/i.exec(text);
		if (!entry) { problems.push(`line ${line.n}: budget lines must be \`<key>: <positive integer>\`, got "${text}"; ${allowed}`); continue; }
		const name = entry[1].toLowerCase().replace(/[\s-]+/g, "_");
		const key = Object.hasOwn(BUDGET_KEYS, name) ? BUDGET_KEYS[name] : undefined;
		const value = entry[2].trim();
		if (!key) problems.push(`line ${line.n}: unknown budget key "${name}"; ${allowed}`);
		else if (/^\d+$/.test(value) && Number(value) > 0) budget[key] = Number(value);
		else problems.push(`line ${line.n}: budget ${name} must be a positive integer, got "${value}"`);
	}
	return budget;
}

function listItems(lines: Line[]): string[] {
	const items: string[] = [];
	let open = false;
	for (const line of lines) {
		// Code blocks stay verbatim inside the item they follow.
		if (line.fenced) { if (open) items[items.length - 1] += `\n${line.text}`; else { items.push(line.text); open = true; } continue; }
		if (!line.text.trim()) { open = false; continue; }
		const bullet = BULLET.exec(line.text);
		if (bullet && (!open || !bullet[1])) items.push(bullet[2].trim());
		else if (open) items[items.length - 1] += ` ${line.text.trim()}`;
		else items.push(line.text.trim());
		open = true;
	}
	return items.filter(Boolean);
}
