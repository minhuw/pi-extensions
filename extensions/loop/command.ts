import { Cron } from "croner";

export type Schedule = { kind: "interval"; everyMs: number } | { kind: "cron"; expression: string } | { kind: "dynamic" };
export interface StartOptions {
	prompt: string;
	name?: string;
	schedule: Schedule;
	max: number;
	forMs: number;
	timeoutMs: number;
	until?: string;
	converged?: number;
	wait: boolean;
}
export type Command = { action: "start"; options: StartOptions } | { action: "list" | "help" | "pause" | "resume" | "stop"; target?: string };

export const HELP = [
	"/loop [5m] <prompt> [--name build] [--max 25] [--for 6h]",
	"/loop --cron \"*/5 * * * *\" <prompt>",
	"/loop <prompt>  (model-paced, 60s–1h)",
	"Options: --wait, --until \"completion text\", --converged 3, --timeout 15m",
	"/loop list | pause|resume|stop [name|id|all]",
].join("\n");

/** Deliberately explicit durations: no accidental interpretation of prose as a schedule. */
export function duration(text: string): number {
	const normalized = text.toLowerCase();
	if (!/^(?:\d+(?:\.\d+)?[smhd])+$/.test(normalized)) throw new Error(`Invalid duration '${text}'; use 5m, 1h30m, or 2d.`);
	let total = 0;
	for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) {
		total += Number(match[1]) * ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!]!);
	}
	if (!Number.isSafeInteger(total) || total <= 0 || total > 365 * 86_400_000) throw new Error("Duration must be positive and at most 365 days.");
	return total;
}

interface Token { value: string; start: number; end: number; quoted: boolean }
function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		if (/\s/.test(text[i]!)) { i++; continue; }
		const start = i;
		let value = "";
		let quote = "";
		let quoted = false;
		while (i < text.length && (quote || !/\s/.test(text[i]!))) {
			const char = text[i++]!;
			if (char === "\\" && i < text.length && (text[i] === quote || text[i] === "\\" || (!quote && /\s/.test(text[i]!)))) value += text[i++];
			else if (quote && char === quote) quote = "";
			else if (!quote && value.length === 0 && (char === '"' || char === "'")) { quote = char; quoted = true; }
			else value += char;
		}
		if (quote) throw new Error("Unclosed quote in /loop command.");
		tokens.push({ value, start, end: i, quoted });
	}
	return tokens;
}

export function nextDue(schedule: Exclude<Schedule, { kind: "dynamic" }>, after: number, anchor: number): number {
	if (schedule.kind === "interval") {
		return anchor + (Math.floor((after - anchor) / schedule.everyMs) + 1) * schedule.everyMs;
	}
	const cron = new Cron(schedule.expression, { paused: true, mode: "5-part", legacyMode: true });
	try {
		const next = cron.nextRun(new Date(after));
		if (!next) throw new Error("Cron expression has no future occurrence.");
		return next.getTime();
	} finally { cron.stop(); }
}

export function parseCommand(text: string): Command {
	const tokens = tokenize(text);
	const first = tokens[0];
	if (!first) return { action: "list" };
	if (!first.quoted && ["list", "status", "help", "pause", "resume", "stop"].includes(first.value)) {
		const action = first.value === "status" ? "list" : first.value as "list" | "help" | "pause" | "resume" | "stop";
		if (tokens.length > 2 || (action === "help" && tokens.length > 1)) throw new Error(HELP);
		return { action, target: tokens[1]?.value };
	}
	const flags = new Map<string, string>();
	let wait = false;
	let start = 0;
	let end = tokens.length;
	const isDuration = (token: Token | undefined) => token && !token.quoted && /^(?:\d+(?:\.\d+)?[smhd])+$/i.test(token.value);
	let schedule: Schedule = { kind: "dynamic" };
	const takeFlag = (head: boolean): boolean => {
		const position = head ? start : end - 1;
		const token = tokens[position];
		if (!token || (head && token.quoted)) return false;
		if (!token.quoted && token.value === "--wait") {
			if (wait) throw new Error("Duplicate --wait.");
			wait = true;
			if (head) start++; else end--;
			return true;
		}
		const flag = head ? token : tokens[end - 2];
		if (!flag || flag.quoted || !flag.value.startsWith("--")) {
			if (!head && !token.quoted && token.value.startsWith("--")) throw new Error(`Missing value or unknown option ${token.value}.`);
			return false;
		}
		if (!["--name", "--max", "--for", "--timeout", "--until", "--converged", "--cron"].includes(flag.value)) throw new Error(`Unknown option ${flag.value}.`);
		const value = head ? tokens[start + 1] : token;
		if (!value || (!value.quoted && value.value.startsWith("--"))) throw new Error(`Missing value for ${flag.value}.`);
		if (flags.has(flag.value)) throw new Error(`Duplicate ${flag.value}.`);
		flags.set(flag.value, value.value);
		if (head) start += 2; else end -= 2;
		return true;
	};
	// Flags and one cadence may sit at either edge; prompt prose between them is untouched.
	for (;;) {
		if (takeFlag(true) || takeFlag(false)) continue;
		const edge = start < end ? (isDuration(tokens[start]) ? start : isDuration(tokens[end - 1]) ? end - 1 : -1) : -1;
		if (schedule.kind !== "dynamic" || edge === -1) break;
		schedule = { kind: "interval", everyMs: duration(tokens[edge]!.value) };
		if (edge === start) start++; else end--;
	}
	if (flags.has("--cron")) {
		if (schedule.kind !== "dynamic") throw new Error("Choose one interval or cron expression.");
		schedule = { kind: "cron", expression: flags.get("--cron")! };
		nextDue(schedule, Date.now(), Date.now());
	}
	if (schedule.kind === "interval" && schedule.everyMs < 60_000) throw new Error("Minimum loop interval is 1m.");
	if (start >= end) throw new Error("A loop needs a prompt.\n" + HELP);
	// Preserve whitespace, quotes and backslashes inside unquoted multi-token prompts.
	const prompt = end - start === 1 && tokens[start]!.quoted
		? tokens[start]!.value : text.slice(tokens[start]!.start, tokens[end - 1]!.end);
	const integer = (flag: string, fallback: number, minimum: number, maximum: number): number => {
		const raw = flags.get(flag);
		if (raw === undefined) return fallback;
		if (!/^\d+$/.test(raw) || Number(raw) < minimum || Number(raw) > maximum) throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}.`);
		return Number(raw);
	};
	const name = flags.get("--name");
	if (name !== undefined && (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(name) || name === "all")) throw new Error("Use a name of 1–32 letters, digits, hyphens or underscores (except 'all').");
	if (!prompt.trim()) throw new Error("A loop needs a nonempty prompt.");
	if (prompt.length > 100_000) throw new Error("Loop prompts must be at most 100,000 characters.");
	if (flags.has("--until") && !flags.get("--until")?.trim()) throw new Error("--until needs nonempty completion text.");
	if (wait && schedule.kind === "dynamic") throw new Error("--wait requires an interval or cron schedule.");
	return { action: "start", options: {
		prompt, name, schedule, max: integer("--max", 25, 1, 10_000),
		forMs: duration(flags.get("--for") ?? "6h"), timeoutMs: duration(flags.get("--timeout") ?? "15m"),
		until: flags.get("--until"), converged: flags.has("--converged") ? integer("--converged", 3, 2, 100) : undefined, wait,
	} };
}
