import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRoles } from "../../src/agents/roles.ts";
import { DEFAULT_ROLE, LIMITS } from "../../src/config.ts";
import type { AgentOptions, CheckResult, IntegrateOptions, IntegrateResult, StepResult, WorkflowBridge } from "../../src/types.ts";
import { runScript } from "../../src/workflow/sandbox.ts";
import type { ScriptOutcome } from "../../src/workflow/sandbox.ts";

export type TemplateName = "sequential" | "disjoint" | "explore";
export const CHECKS = ["unit-tests", "typecheck"];
const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));
export const template = (name: TemplateName) => readFileSync(join(TEMPLATE_DIR, `${name}.js`), "utf8");

/** The built-in roles only: an empty override dir keeps the user's own role files out of the tests. */
export const ROLES = (() => {
	const dir = mkdtempSync(join(tmpdir(), "herder-templates-roles-"));
	try { return loadRoles({ overrideDir: dir }); }
	finally { rmSync(dir, { recursive: true, force: true }); }
})();
export const ROLE_NAMES = [...ROLES.keys()];

export const sha = (label: string) => Buffer.from(label).toString("hex").padEnd(40, "0").slice(0, 40);
export const check = (id: string, passed: boolean, tail = passed ? "ok" : "FAIL"): CheckResult =>
	({ id, commit: sha("check"), exitCode: passed ? 0 : 1, timedOut: false, durationMs: 1200, tail, logRef: `outputs/${id}.txt`, passed });

/** What a scripted agent returns; `key`, `reused`, and (for writers that are not `no_changes`) `commit` are filled in. */
export type Reply = Partial<StepResult> & { status: StepResult["status"] };
export interface AgentCall { prompt: string; opts: AgentOptions; result: StepResult }
export interface IntegrateCall { source: StepResult | string; opts: IntegrateOptions; from: string; result: IntegrateResult }

/** The fingerprint-relevant parts of a call (§6), compared per explicit id within one launch. */
const identity = (prompt: string, opts: AgentOptions) =>
	JSON.stringify([prompt, opts.role ?? DEFAULT_ROLE, opts.write ?? null, opts.base ?? null, opts.gate ?? null, opts.schema ?? null]);
export const writes = (role: string | undefined, write: boolean | undefined) => write ?? ROLES.get(role ?? DEFAULT_ROLE)?.write ?? true;

/**
 * A scripted `WorkflowBridge`. `agent` replies come from `replies[id]` (a value, or one per call in order);
 * `integrate` replies are taken from `integrations` in call order and default to "integrated" with a fresh head.
 * It rejects calls without an explicit id and an id reused with a different prompt or options, as the executor does.
 */
export class ScriptedBridge implements WorkflowBridge {
	agents: AgentCall[] = [];
	integrations: IntegrateCall[] = [];
	phases: string[] = [];
	logs: string[] = [];
	violations: string[] = [];
	head = sha("start");
	private seen = new Map<string, string>();
	private counts = new Map<string, number>();
	constructor(readonly replies: Record<string, Reply | Reply[] | ((prompt: string, opts: AgentOptions) => Reply)> = {}, readonly integrateReplies: Partial<IntegrateResult>[] = []) {}

	async agent(prompt: string, opts: AgentOptions): Promise<StepResult> {
		const id = opts.id;
		if (!id) { this.violations.push(`agent() without an explicit id: ${prompt.slice(0, 40)}`); throw new Error("agent() needs an explicit id"); }
		const prior = this.seen.get(id);
		if (prior !== undefined && prior !== identity(prompt, opts)) { this.violations.push(`id ${id} reused with a different call`); throw new Error(`id ${id} reused`); }
		this.seen.set(id, identity(prompt, opts));
		const count = this.counts.get(id) ?? 0;
		this.counts.set(id, count + 1);
		const scripted = this.replies[id];
		const reply = typeof scripted === "function" ? scripted(prompt, opts) : Array.isArray(scripted) ? scripted[count] : scripted;
		if (!reply) throw new Error(`no scripted reply for ${id} (call ${count + 1})`);
		const writer = writes(opts.role, opts.write);
		const result: StepResult = {
			key: `${id}-0`, reused: false, text: "",
			...(writer && reply.status !== "no_changes" && reply.status !== "failed" && reply.status !== "stopped" ? { commit: sha(id) } : {}),
			...reply,
		};
		this.agents.push({ prompt, opts, result });
		return result;
	}

	async integrate(source: StepResult | string, opts: IntegrateOptions): Promise<IntegrateResult> {
		const reply = this.integrateReplies[this.integrations.length] ?? {};
		const from = this.head;
		const status = reply.status ?? "integrated";
		const result: IntegrateResult = status === "integrated" ? { status, head: sha(`head-${this.integrations.length + 1}`), ...reply } : { status, ...reply };
		if (result.status === "integrated") this.head = result.head!;
		this.integrations.push({ source, opts, from, result });
		return result;
	}

	log(message: string) { this.logs.push(message); }
	phase(title: string) { this.phases.push(title); }
	ids() { return this.agents.map(call => call.opts.id); }
	call(id: string) {
		const found = this.agents.find(call => call.opts.id === id);
		if (!found) throw new Error(`no agent call ${id}; calls: ${this.ids().join(", ")}`);
		return found;
	}
}

/** Runs a template in the real sandbox against `bridge`. */
export async function runTemplate(name: TemplateName, args: unknown, bridge: ScriptedBridge): Promise<ScriptOutcome> {
	return runScript({ source: template(name), args, bridge, limits: LIMITS, writes, filename: `${name}.js` }).done;
}
