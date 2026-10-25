import { DEFAULT_ROLE, LIMITS } from "../config.ts";
import { stableJson, stepId } from "../journal/keys.ts";
import type { IntegrateResult, Limits, StepResult } from "../types.ts";
import { startSandbox, syntaxProblem } from "./sandbox.ts";
import type { CallSite, SandboxCall, ScriptProblem } from "./sandbox.ts";

export type { ScriptProblem } from "./sandbox.ts";
export interface ValidationContext {
	roles: readonly string[]; checks: readonly string[];
	/** Roles that cannot run with `write: true`; the others write by default. */
	readOnlyRoles?: readonly string[];
	/** Launch args for the dry run. */
	args?: unknown;
	/** Wall-clock budget for the dry run (default 2 s); running out is a warning. */
	budgetMs?: number;
	limits?: Limits;
}
export interface ValidationReport { ok: boolean; problems: ScriptProblem[]; agentCalls: number; integrateCalls: number; note: string }

export const DRY_RUN_NOTE = "The dry run follows only the path that synthetic results take (every agent() returns status \"ok\", every integrate() returns \"integrated\"); other branches were compiled but not exercised.";
const ZERO_SHA = "0".repeat(40);
/** Distinct synthetic commits ("c…") and heads ("d…"), so default bases differ across integrations as they do live. */
const fakeSha = (prefix: string, n: number) => prefix + n.toString(16).padStart(39, "0");
const SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];

/** Compiles and dry-runs a script against a stub bridge; never runs agents. */
export async function validateScript(source: string, context: ValidationContext): Promise<ValidationReport> {
	const problems: ScriptProblem[] = [];
	const seen = new Set<string>();
	const add = (problem: ScriptProblem) => {
		const id = `${problem.severity}\0${problem.message}\0${problem.line}\0${problem.column}`;
		if (seen.has(id)) return;
		seen.add(id);
		problems.push(problem);
	};
	const report = (agentCalls = 0, integrateCalls = 0): ValidationReport =>
		({ ok: !problems.some(problem => problem.severity === "error"), problems, agentCalls, integrateCalls, note: DRY_RUN_NOTE });

	const syntax = syntaxProblem(source);
	if (syntax) {
		add(syntax);
		return report();
	}

	let agentCalls = 0, integrateCalls = 0;
	const checks = new Set(context.checks);
	const roles = new Set(context.roles);
	const readOnly = new Set(context.readOnlyRoles ?? []);
	// The launch's logical head, and each step id's inputs: one id with two fingerprints in a launch throws live.
	let head = ZERO_SHA;
	const ids = new Map<string, { inputs: string; rest: string; explicitBase: boolean; site: CallSite | undefined }>();
	const unknownChecks = (what: string, ids: readonly string[], site?: CallSite) => {
		for (const id of ids) if (!checks.has(id)) add(problemAt(`${what} names unknown check "${id}". Known checks: ${known(context.checks)}.`, site));
	};
	const call = async (call: SandboxCall): Promise<StepResult | IntegrateResult> => {
		if (call.method === "integrate") {
			integrateCalls++;
			if (call.opts.checks) unknownChecks("integrate() opts.checks", call.opts.checks, call.site);
			head = fakeSha("d", integrateCalls);
			return { status: "integrated", head };
		}
		agentCalls++;
		const { opts, site } = call;
		const role = opts.role ?? DEFAULT_ROLE;
		if (!roles.has(role)) add(problemAt(`agent() role "${role}" is not a known role. Known roles: ${known(context.roles)}.`, site));
		if (opts.write === true && readOnly.has(role)) add(problemAt(`agent() role "${role}" is read-only; it cannot run with write: true.`, site));
		const gates = opts.gate === undefined ? [] : typeof opts.gate === "string" ? [opts.gate] : opts.gate;
		unknownChecks("agent() opts.gate", gates, site);
		if (opts.schema !== undefined) for (const message of schemaProblems(opts.schema)) add(problemAt(`agent() opts.schema: ${message}`, site));
		const id = opts.id ?? stepId("agent", role, call.prompt);
		const material = { role, prompt: call.prompt, schema: opts.schema, write: opts.write ?? !readOnly.has(role), gates };
		const inputs = stableJson({ ...material, base: opts.base ?? head }), rest = stableJson(material);
		const first = ids.get(id);
		if (!first) ids.set(id, { inputs, rest, explicitBase: opts.base !== undefined, site });
		else if (first.inputs !== inputs) {
			const where = first.site ? ` at line ${first.site.line}` : "";
			// The dry run compares bases as written; live they resolve to commits, and an explicit one may equal the default.
			const baseOnly = first.rest === rest && (first.explicitBase || opts.base !== undefined);
			const problem = problemAt((opts.id !== undefined
				? `agent() id "${id}" is already used${where} by a call with different inputs (prompt, role, base, gates, schema, or write mode); give each distinct call its own id.`
				: `agent() has the same role and prompt as the call${where} but a different base, gates, schema, or write mode, so both get one implicit id; give them explicit ids.`)
				+ (baseOnly ? " Only the base differs: this throws live unless both bases name the same commit." : ""), site);
			add(baseOnly ? { ...problem, severity: "warning" } : problem);
		}
		const data = opts.schema !== undefined ? minimalValue(opts.schema) : undefined;
		return { status: "ok", key: `${opts.id ?? `dry-run-${agentCalls}`}-0`, text: "", ...(data !== undefined ? { data } : {}), commit: fakeSha("c", agentCalls), reused: false };
	};

	const handle = startSandbox({
		source, args: context.args, limits: context.limits ?? LIMITS, collect: true,
		host: { call, log() {}, phase() {}, problem: add },
	});
	const budgetMs = context.budgetMs ?? 2_000;
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; handle.stop(); }, budgetMs);
	const outcome = await handle.done;
	clearTimeout(timer);
	if (timedOut) add({ message: `The dry run did not finish within ${budgetMs} ms and was stopped; the rest of the script was not exercised.`, severity: "warning" });
	else if (outcome.status === "failed") {
		const site = { ...(outcome.line !== undefined ? { line: outcome.line } : {}), ...(outcome.column !== undefined ? { column: outcome.column } : {}) };
		// Once the script holds synthetic results, its own throw may only reflect them (an empty string or array). Before
		// that it depends on the code and args alone; fatal runtime errors, undefined names, and reads of the clock or
		// randomness (DeterminismError) fail every live run, so they are errors either way.
		const thrown = outcome.exception;
		if (thrown && !thrown.fatal && thrown.name !== "ReferenceError" && thrown.name !== "DeterminismError" && agentCalls + integrateCalls > 0) {
			add({ message: `The dry run stopped where the script threw after receiving synthetic results: ${outcome.error ?? "unknown error"}. Real results may not take this path; check that line.`, severity: "warning", ...site });
		} else add({ message: `The dry run failed: ${outcome.error ?? "unknown error"}`, severity: "error", ...site });
	}
	return report(agentCalls, integrateCalls);
}

function problemAt(message: string, site: CallSite | undefined): ScriptProblem {
	return { message, severity: "error", ...(site ? { line: site.line, column: site.column } : {}) };
}

function known(names: readonly string[]): string { return names.length > 0 ? names.join(", ") : "(none)"; }

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural sanity of a JSON Schema used for structured output; not a full meta-schema check. */
export function schemaProblems(schema: unknown, where = "schema", root = true): string[] {
	if (!isObject(schema)) return [`${where} must be a JSON Schema object.`];
	const problems: string[] = [];
	const { type } = schema;
	if (root && type !== "object") problems.push('schema must have type "object" at its root.');
	if (type !== undefined) {
		const types = Array.isArray(type) ? type : [type];
		if (types.length === 0 || !types.every(t => typeof t === "string" && SCHEMA_TYPES.includes(t))) {
			problems.push(`${where} has unknown type ${JSON.stringify(type)}; use one of ${SCHEMA_TYPES.join(", ")}.`);
		}
	}
	if (schema.properties !== undefined) {
		if (!isObject(schema.properties)) problems.push(`${where}.properties must be an object.`);
		else for (const [name, child] of Object.entries(schema.properties)) problems.push(...schemaProblems(child, `${where}.properties.${name}`, false));
	}
	if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every(name => typeof name === "string"))) {
		problems.push(`${where}.required must be an array of property names.`);
	}
	if (schema.items !== undefined) {
		if (Array.isArray(schema.items)) schema.items.forEach((child, index) => problems.push(...schemaProblems(child, `${where}.items[${index}]`, false)));
		else problems.push(...schemaProblems(schema.items, `${where}.items`, false));
	}
	if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
		problems.push(...schemaProblems(schema.additionalProperties, `${where}.additionalProperties`, false));
	}
	if (schema.enum !== undefined && !(Array.isArray(schema.enum) && schema.enum.length > 0)) problems.push(`${where}.enum must be a non-empty array.`);
	for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
		const list = schema[keyword];
		if (list === undefined) continue;
		if (!Array.isArray(list) || list.length === 0) problems.push(`${where}.${keyword} must be a non-empty array of schemas.`);
		else list.forEach((child, index) => problems.push(...schemaProblems(child, `${where}.${keyword}[${index}]`, false)));
	}
	return problems;
}

/** The smallest value a script could receive for `schema`: every property present, arrays at their minimum length. */
export function minimalValue(schema: unknown): unknown {
	if (!isObject(schema)) return null;
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
	if ("const" in schema) return schema.const;
	for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
		const list = schema[keyword];
		if (schema.type === undefined && Array.isArray(list) && list.length > 0) return minimalValue(list[0]);
	}
	const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
	switch (type) {
		case "object": {
			const value: Record<string, unknown> = {};
			if (isObject(schema.properties)) for (const [name, child] of Object.entries(schema.properties)) value[name] = minimalValue(child);
			return value;
		}
		case "array": {
			const count = typeof schema.minItems === "number" ? Math.min(schema.minItems, 16) : 0;
			return Array.from({ length: count }, () => minimalValue(schema.items));
		}
		case "string": return "";
		case "number": case "integer": return typeof schema.minimum === "number" ? schema.minimum : 0;
		case "boolean": return false;
		default: return null;
	}
}
