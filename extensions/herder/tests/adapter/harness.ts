import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { registerHerder } from "../../src/adapter/extension.ts";
import type { HerderRuntime, LaunchOutcome, LaunchRequest, RuntimeEnv, RuntimeFactory, StepActivity } from "../../src/adapter/runtime.ts";
import type { Herder, HerderOptions } from "../../src/adapter/session.ts";
import { ACTIVITY_EVENT } from "../../src/config.ts";
import type { AgentOptions, IntegrateOptions } from "../../src/types.ts";

export const VALID_GOAL = `# Goal: Add a greeting

## Intent
Users want a friendly greeting.

## Acceptance criteria
- AC-1: WHEN the program runs THE SYSTEM SHALL print hello. verify: check:unit

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| unit | true | 1m | yes |
`;

interface FakeLaunch { launch: number; request: LaunchRequest; stopped?: string; settle(outcome?: Partial<LaunchOutcome>): void }

export class FakeRuntime implements HerderRuntime {
	readonly env: RuntimeEnv;
	readonly calls: Array<[string, ...unknown[]]> = [];
	readonly launches: FakeLaunch[] = [];
	/** Activity the next step emits before it settles. */
	stepActivity: Omit<StepActivity, "state"> | undefined;
	/** While set, steps wait for it (or their signal) before returning. */
	stepGate: Promise<unknown> | undefined;
	/** While set, `launch` waits for it before starting the launch. */
	launchGate: Promise<unknown> | undefined;
	/** A stop does not settle the launch; the test settles it. */
	holdOnStop = false;
	readonly signals: AbortSignal[] = [];
	constructor(env: RuntimeEnv) { this.env = env; }

	roles() { return ["worker", "reviewer"]; }
	readOnlyRoles() { return ["reviewer"]; }
	start() { this.calls.push(["start"]); }
	async step(prompt: string, opts: AgentOptions, signal?: AbortSignal) {
		this.calls.push(["step", prompt, opts]);
		if (signal) this.signals.push(signal);
		if (this.stepGate) {
			await Promise.race([this.stepGate, new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }))]);
			this.calls.push(["step settled", signal?.aborted ?? false]);
			if (signal?.aborted) return { status: "stopped" as const, key: "step-0", reused: false };
		}
		if (this.stepActivity) this.env.onActivity({ ...this.stepActivity, state: "running" });
		if (this.stepActivity) this.env.onActivity({ ...this.stepActivity, state: "settled" });
		return { status: "ok" as const, key: "step-0", commit: "c".repeat(40), reused: false };
	}
	async integrate(source: string, opts: IntegrateOptions) {
		this.calls.push(["integrate", source, opts]);
		return { status: "integrated" as const, head: "d".repeat(40), checks: [] };
	}
	async check(request: { checks?: string[]; commit?: string }) { this.calls.push(["check", request]); return []; }
	async verify() {
		this.calls.push(["verify"]);
		return { verdict: "met" as const, head: "d".repeat(40), checks: [], criteria: [], gaps: [], verifierRan: false };
	}
	async deliver(request: { mode: string; curate?: boolean }, confirm: (summary: string) => Promise<boolean>) {
		this.calls.push(["deliver", request]);
		const mode = request.mode as "series";
		if (!(await confirm("deliver 1 commit"))) return { status: "cancelled" as const, mode };
		this.env.run.journal.append({ t: "delivery.completed", mode, target: "main", tip: "d".repeat(40), commits: ["d".repeat(40)] });
		return { status: "delivered" as const, mode, target: "main", tip: "d".repeat(40), commits: ["d".repeat(40)] };
	}
	async launch(request: LaunchRequest) {
		this.calls.push(["launch", request]);
		if (this.launchGate) await this.launchGate;
		const { launch } = this.env.run.writeScript(request.source);
		this.env.run.journal.append({ t: "script.launched", launch, scriptSha256: "0".repeat(64), args: request.args ?? null, head: this.env.run.state().integrationHead!, ...(request.resume ? { resumes: request.resume } : {}) });
		let resolve!: (outcome: LaunchOutcome) => void;
		const done = new Promise<LaunchOutcome>((r) => { resolve = r; });
		const entry: FakeLaunch = {
			launch, request,
			settle: (outcome = {}) => {
				const settled = { launch, status: "completed" as const, reused: 0, changed: 0, new: 0, ...outcome };
				this.env.run.journal.append({ t: "script.settled", launch, status: settled.status, reused: settled.reused, changed: settled.changed, new: settled.new });
				resolve(settled);
			},
		};
		this.launches.push(entry);
		return { launch, done, stop: (reason?: string) => { entry.stopped = reason ?? "stopped"; if (!this.holdOnStop) entry.settle({ status: "stopped" }); } };
	}
	async abandon(reason: string) {
		this.calls.push(["abandon", reason]);
		this.env.run.journal.append({ t: "run.finished", status: "abandoned", reason });
	}
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface HarnessOptions { cwd: string; sessionId?: string; hasUI?: boolean; options?: Partial<HerderOptions>; events?: ReturnType<typeof createEventBus> }

export function harness({ cwd, sessionId = "session-a", hasUI = true, options = {}, events = createEventBus() }: HarnessOptions) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const statuses = new Map<string, string>();
	const sent: any[] = [];
	const notices: Array<{ text: string; level?: string }> = [];
	const snapshots: any[] = [];
	events.on(ACTIVITY_EVENT, (snapshot) => snapshots.push(snapshot));
	const runtimes: FakeRuntime[] = [];
	const createRuntime: RuntimeFactory = (env) => { const runtime = new FakeRuntime(env); runtimes.push(runtime); return runtime; };
	const confirm = vi.fn(async (_title: string, _body: string, _opts?: { signal?: AbortSignal }) => true);
	const ctx = {
		// RPC keeps dialogs on `ui.confirm`; the TUI's scrollable confirm has its own tests.
		mode: hasUI ? "rpc" : "print", hasUI, cwd,
		ui: {
			notify: vi.fn((text: string, level?: string) => notices.push({ text, level })),
			setStatus: vi.fn((key: string, value?: string) => { if (value) statuses.set(key, value); else statuses.delete(key); }),
			confirm,
		},
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: {}, model: undefined,
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		sendMessage: vi.fn((message: unknown) => { sent.push(message); }),
		getThinkingLevel: () => "medium",
		events,
	} as unknown as ExtensionAPI;
	const herder: Herder = registerHerder(pi, { createRuntime, ...options });
	return {
		pi, ctx, herder, commands, tools, handlers, statuses, sent, notices, snapshots, runtimes, confirm, events,
		command: (args: string) => commands.get("herder").handler(args, ctx) as Promise<void>,
		tool: (name: string, params: unknown, signal?: AbortSignal) => tools.get(name).execute("call", params, signal, undefined, ctx),
		shutdown: async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx); },
		lastNotice: () => notices.at(-1),
		runtime: () => runtimes.at(-1)!,
	};
}
