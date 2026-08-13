export interface FireOptions {
	mode: "fire" | "resume" | "revise";
	planDir: string;
	profile?: string;
	maxParallel?: number;
	dashboardPort: number;
}

export interface AttachOptions {
	planDir: string;
	dashboardPort: number;
}

export interface PlanDirOptions {
	planDir?: string;
}

export interface CleanupCommandOptions {
	planDir: string;
	planId?: string;
	includeFailed: boolean;
	deep: boolean;
	force: boolean;
}

export const HERDER_CLEANUP_COMMAND_USAGE = [
	"Usage:",
	"  /herder-cleanup [plan-dir] [--plan <id>] [--include-failed]",
	"  /herder-cleanup [plan-dir] --deep [--include-failed]",
	"  /herder-cleanup [plan-dir] --force",
].join("\n");

export const HERDER_RESET_COMMAND_USAGE = "Usage:\n  /herder-reset [plan-dir]";

export interface ResetCommandOptions { planDir: string }

export interface GrillPlanTarget {
	planId: string;
	planDir?: string;
}

export const HERDER_PLAN_COMMAND_USAGE = [
	"Usage:",
	"  /herder-plans init [plan-dir] [--track]",
	"  /herder-plans validate|shape|status|ready [plan-dir]",
	"  /herder-plans snapshot <plan-id> [plan-dir]",
	"  /herder-plans report <plan-id|RUN> [plan-dir]",
	"  /herder-plans track|untrack [plan-dir]",
].join("\n");

export interface PlanCommandOptions {
	operation: "init" | "validate" | "shape" | "status" | "ready" | "snapshot" | "report" | "track" | "untrack";
	planDir: string;
	planId?: string;
	track?: boolean;
}

export function tokenizeArguments(input: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	let started = false;
	for (const character of input) {
		if (escaped) {
			token += character;
			escaped = false;
			started = true;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = null;
			else token += character;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started) {
				tokens.push(token);
				token = "";
				started = false;
			}
			continue;
		}
		token += character;
		started = true;
	}
	if (escaped) throw new Error("Arguments end with an incomplete escape.");
	if (quote) throw new Error("Arguments contain an unterminated quote.");
	if (started) tokens.push(token);
	return tokens;
}

function valueAfter(tokens: string[], index: number, option: string): string {
	const value = tokens[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
	return value;
}

function positiveInteger(value: string, option: string, maximum: number): number {
	if (!/^\d+$/.test(value)) throw new Error(`${option} must be a positive integer.`);
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
		throw new Error(`${option} must be between 1 and ${maximum}.`);
	}
	return parsed;
}

function port(value: string): number {
	if (!/^\d+$/.test(value)) throw new Error("--dashboard-port must be an integer from 0 through 65535.");
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
		throw new Error("--dashboard-port must be an integer from 0 through 65535.");
	}
	return parsed;
}

export function parseFireArguments(input: string, mode: "fire" | "resume" | "revise"): FireOptions {
	const tokens = tokenizeArguments(input);
	let planDir = "herder-plans";
	let profile: string | undefined;
	let maxParallel: number | undefined;
	let dashboardPort = 0;
	let positional = false;

	for (let index = 0; index < tokens.length; index += 1) {
		const argument = tokens[index]!;
		if (["--profile", "--max-parallel", "--dashboard-port"].includes(argument)) {
			const value = valueAfter(tokens, index, argument);
			index += 1;
			if (argument === "--profile") {
				if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error("--profile is not a valid profile name.");
				profile = value;
			} else if (argument === "--max-parallel") maxParallel = positiveInteger(value, argument, 32);
			else dashboardPort = port(value);
		} else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
		else if (positional) throw new Error(`Unexpected argument: ${argument}`);
		else {
			planDir = argument;
			positional = true;
		}
	}

	return { mode, planDir, ...(profile ? { profile } : {}), ...(maxParallel === undefined && mode !== "fire" ? {} : { maxParallel: maxParallel ?? 5 }), dashboardPort };
}

export function parseAttachArguments(input: string): AttachOptions {
	const tokens = tokenizeArguments(input);
	let planDir = "herder-plans";
	let dashboardPort = 0;
	let positional = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const argument = tokens[index]!;
		if (argument === "--dashboard-port") {
			dashboardPort = port(valueAfter(tokens, index, argument));
			index += 1;
		} else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
		else if (positional) throw new Error(`Unexpected argument: ${argument}`);
		else {
			planDir = argument;
			positional = true;
		}
	}
	return { planDir, dashboardPort };
}

export function parsePlanDirArguments(input: string): PlanDirOptions {
	const tokens = tokenizeArguments(input);
	if (tokens.length > 1) throw new Error("Expected at most one plan directory.");
	if (tokens[0]?.startsWith("--")) throw new Error(`Unknown option: ${tokens[0]}`);
	return tokens[0] ? { planDir: tokens[0] } : {};
}

export function parseCleanupArguments(input: string): CleanupCommandOptions {
	const tokens = tokenizeArguments(input);
	let planDir = "herder-plans";
	let planId: string | undefined;
	let includeFailed = false;
	let deep = false;
	let force = false;
	let positional = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const argument = tokens[index]!;
		if (argument === "--include-failed") {
			if (includeFailed) throw new Error("--include-failed was provided more than once.");
			includeFailed = true;
			continue;
		}
		if (argument === "--deep") {
			if (deep) throw new Error("--deep was provided more than once.");
			deep = true;
			continue;
		}
		if (argument === "--force") {
			if (force) throw new Error("--force was provided more than once.");
			force = true;
			continue;
		}
		if (argument === "--finalize" || argument === "--handoff-target") {
			throw new Error(`${argument} was removed; use --deep for proven destructive cleanup or --force to destroy the plan set unconditionally.\n${HERDER_CLEANUP_COMMAND_USAGE}`);
		}
		if (argument === "--plan") {
			if (planId !== undefined) throw new Error("--plan was provided more than once.");
			const value = valueAfter(tokens, index, argument);
			if (!/^\d+$/.test(value)) throw new Error("--plan must be a numeric plan ID.");
			planId = value;
			index += 1;
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}\n${HERDER_CLEANUP_COMMAND_USAGE}`);
		if (positional) throw new Error(`Unexpected argument: ${argument}\n${HERDER_CLEANUP_COMMAND_USAGE}`);
		planDir = argument;
		positional = true;
	}
	if (force && (deep || includeFailed || planId !== undefined)) {
		throw new Error(`--force cannot be combined with --deep, --plan, or --include-failed.\n${HERDER_CLEANUP_COMMAND_USAGE}`);
	}
	if (deep && planId !== undefined) throw new Error("--deep is plan-set-level and cannot be combined with --plan.");
	return { planDir, ...(planId === undefined ? {} : { planId }), includeFailed, deep, force };
}


export function parseResetArguments(input: string): ResetCommandOptions {
	const tokens = tokenizeArguments(input);
	if (tokens.length > 1) throw new Error(`${HERDER_RESET_COMMAND_USAGE}`);
	if (tokens[0]?.startsWith("--")) throw new Error(`Unknown option: ${tokens[0]}\n${HERDER_RESET_COMMAND_USAGE}`);
	return { planDir: tokens[0] ?? "herder-plans" };
}


export function parseGrillPlanTarget(input: string): GrillPlanTarget | null {
	const tokens = tokenizeArguments(input);
	let planId: string | undefined;
	let planDir: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const argument = tokens[index]!;
		if (argument === "--plan" || argument === "--plan-dir") {
			const value = valueAfter(tokens, index, argument);
			index += 1;
			if (argument === "--plan") {
				if (planId) throw new Error("--plan was provided more than once.");
				planId = value;
			} else {
				if (planDir) throw new Error("--plan-dir was provided more than once.");
				planDir = value;
			}
		}
	}
	return planId ? { planId, ...(planDir ? { planDir } : {}) } : null;
}

export function parsePlanCommandArguments(input: string): PlanCommandOptions {
	const tokens = tokenizeArguments(input);
	const operation = tokens.shift();
	if (!operation) throw new Error(HERDER_PLAN_COMMAND_USAGE);
	if (!["init", "validate", "shape", "status", "ready", "snapshot", "report", "track", "untrack"].includes(operation)) {
		throw new Error(`Unknown Herder plan operation: ${operation}\n${HERDER_PLAN_COMMAND_USAGE}`);
	}

	let track = false;
	for (let index = 0; index < tokens.length;) {
		const argument = tokens[index]!;
		if (argument === "--track") {
			if (track) throw new Error("--track was provided more than once.");
			track = true;
			tokens.splice(index, 1);
			continue;
		}
		if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}\n${HERDER_PLAN_COMMAND_USAGE}`);
		index += 1;
	}
	if (track && operation !== "init") throw new Error("--track is valid only with /herder-plans init.");

	if (operation === "snapshot" || operation === "report") {
		if (tokens.length < 1 || tokens.length > 2) throw new Error(HERDER_PLAN_COMMAND_USAGE);
		const [planId, planDir = "herder-plans"] = tokens;
		return {
			operation: operation as PlanCommandOptions["operation"],
			planDir,
			planId,
		};
	}
	if (tokens.length > 1) throw new Error(HERDER_PLAN_COMMAND_USAGE);
	return {
		operation: operation as PlanCommandOptions["operation"],
		planDir: tokens[0] ?? "herder-plans",
		...(operation === "init" ? { track } : {}),
	};
}
