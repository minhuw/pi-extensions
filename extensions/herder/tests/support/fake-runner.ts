import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { AgentError, type AgentRunner, type AgentRunRequest, type AgentRunResult, type ErrorClass, type RoleDefinition, type Usage } from "../../src/types.ts";

type Value<T> = T | ((request: AgentRunRequest, call: number) => T);

/** One scripted behavior. The first rule whose `match` accepts a request (and has uses left) handles it. */
export interface FakeRule {
	match: string | RegExp | ((request: AgentRunRequest) => boolean); // a string matches as a substring of the prompt
	role?: string;
	/** Paths relative to the request's cwd; `null` deletes. */
	files?: Value<Record<string, string | null>>;
	edit?: (cwd: string, request: AgentRunRequest) => void | Promise<void>;
	text?: Value<string>;
	data?: string | number | boolean | null | object | ((request: AgentRunRequest, call: number) => unknown);
	usage?: Usage;
	/** Throws `AgentError(fail)` after applying edits, so callers see changes left behind by a failed attempt. */
	fail?: ErrorClass;
	message?: string;
	/** Waits until the request's stall window (or timeout) expires without emitting events, then throws accordingly. */
	stall?: boolean;
	/** Never settles until the request is aborted. */
	hang?: boolean;
	delayMs?: number;
	/** Resolves before the rule proceeds; use it to hold agents in flight. */
	waitFor?: Promise<unknown>;
	/** Uses before the rule is exhausted; unlimited by default. */
	times?: number;
}

export interface FakeCall { prompt: string; role: string; cwd: string; schema?: object; rule: number }

export class FakeRunner implements AgentRunner {
	readonly calls: FakeCall[] = [];
	readonly rules: FakeRule[];
	private readonly used = new Map<FakeRule, number>();
	private live = 0;
	/** Highest number of concurrently running requests observed. */
	maxConcurrent = 0;

	constructor(rules: FakeRule[] = []) { this.rules = [...rules]; }

	add(...rules: FakeRule[]): this {
		this.rules.push(...rules);
		return this;
	}

	callsMatching(pattern: string | RegExp): FakeCall[] {
		return this.calls.filter((call) => typeof pattern === "string" ? call.prompt.includes(pattern) : pattern.test(call.prompt));
	}

	async run(request: AgentRunRequest): Promise<AgentRunResult> {
		const index = this.rules.findIndex((rule) => this.accepts(rule, request));
		this.calls.push({ prompt: request.prompt, role: request.role.name, cwd: request.cwd, schema: request.schema, rule: index });
		if (index < 0) throw new AgentError("fatal", `FakeRunner: no rule matches prompt ${JSON.stringify(request.prompt.slice(0, 120))}`);
		const rule = this.rules[index]!;
		const call = (this.used.get(rule) ?? 0) + 1;
		this.used.set(rule, call);
		this.live++;
		this.maxConcurrent = Math.max(this.maxConcurrent, this.live);
		try {
			request.onEvent?.("agent_start");
			if (rule.waitFor) await abortable(rule.waitFor, request.signal);
			if (rule.delayMs) await abortable(sleep(rule.delayMs), request.signal);
			if (rule.hang) await abortable(new Promise(() => {}), request.signal);
			if (rule.stall) {
				const stall = request.stallMs <= request.timeoutMs;
				await abortable(sleep(Math.min(request.stallMs, request.timeoutMs)), request.signal);
				throw new AgentError(stall ? "stall" : "timeout", stall ? `no agent events for ${request.stallMs} ms` : `attempt exceeded ${request.timeoutMs} ms`);
			}
			const files = resolve(rule.files, request, call);
			for (const [path, content] of Object.entries(files ?? {})) {
				const target = join(request.cwd, path);
				if (content === null) rmSync(target, { force: true });
				else {
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(target, content);
				}
			}
			await rule.edit?.(request.cwd, request);
			request.onEvent?.("agent_end");
			if (rule.fail) throw new AgentError(rule.fail, rule.message ?? `scripted ${rule.fail} failure`);
			const result: AgentRunResult = { text: resolve(rule.text, request, call) ?? "done" };
			const data = resolve(rule.data, request, call);
			if (data !== undefined) result.data = data;
			if (rule.usage) result.usage = rule.usage;
			return result;
		} finally {
			this.live--;
		}
	}

	private accepts(rule: FakeRule, request: AgentRunRequest): boolean {
		if (rule.times !== undefined && (this.used.get(rule) ?? 0) >= rule.times) return false;
		if (rule.role !== undefined && rule.role !== request.role.name) return false;
		const { match } = rule;
		if (typeof match === "string") return request.prompt.includes(match);
		if (match instanceof RegExp) return match.test(request.prompt);
		return match(request);
	}
}

/** A resolved role for tests that do not load role files. */
export function fakeRole(name = "worker", write = name === "worker" || name === "resolver" || name === "curator"): RoleDefinition {
	const role = { name, description: `${name} (test)`, write, tools: write ? ["read", "edit", "write", "bash"] : ["read", "bash"], model: "inherit", thinking: "inherit", prompt: `You are the ${name}.` };
	return { ...role, sha256: createHash("sha256").update(JSON.stringify(role)).digest("hex") };
}

function resolve<T>(value: Value<T> | undefined, request: AgentRunRequest, call: number): T | undefined {
	return typeof value === "function" ? (value as (request: AgentRunRequest, call: number) => T)(request, call) : value;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new AgentError("fatal", "aborted"));
	return new Promise<T>((done, fail) => {
		const onAbort = () => fail(new AgentError("fatal", "aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(done, fail).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
