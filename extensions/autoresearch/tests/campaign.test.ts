import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import extension from "../index.ts";
import { parseMetrics } from "../../benchmark/core.ts";
import { approvalKey, ITERATION, restoreState, type State } from "../campaign.ts";
import { renderReport, SNAPSHOT } from "../report.ts";

async function fixture(mode: "tui" | "rpc" | "print" = "tui") {
	const directory = await mkdtemp(join(tmpdir(), "pi-autoresearch-campaign-"));
	await writeFile(join(directory, "measure.sh"), "printf 'METRIC compile_ms=100\\n'\n");
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const tools = new Map<string, any>(); const commands = new Map<string, any>(); const entries: any[] = [];
	const statuses = new Map<string, string>(); const messages: any[] = [];
	let idle = true; let queued = false;
	let values = [100, 110, 90];
	const ctx = {
		mode, hasUI: mode !== "print", cwd: directory,
		isIdle: () => idle, hasPendingMessages: () => queued, getContextUsage: () => ({ percent: 20 }),
		abort: vi.fn(),
		sessionManager: { getSessionId: () => "campaign", getBranch: () => entries },
		ui: { notify: vi.fn(), setStatus: (key: string, value?: string) => value ? statuses.set(key, value) : statuses.delete(key) },
		executeTool: vi.fn(async (_name: string, input: { command: string }) => ({
			isError: false, result: { content: [{ type: "text", text: input.command === "check" ? "checks passed" : `METRIC compile_ms=${values.shift() ?? 100}` }], details: undefined },
		})),
	} as unknown as ExtensionToolContext;
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer() {},
		appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) })),
		sendMessage: vi.fn((message: any, options: any) => { messages.push(message); if (options?.triggerTurn) idle = false; }),
	} as unknown as ExtensionAPI;
	extension(pi);
	const emit = async (name: string, event: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	await emit("session_start", { reason: "startup" });
	const state = () => entries.findLast(entry => entry.type === "custom" && entry.customType === SNAPSHOT)?.data as State | undefined;
	const tool = (name: string, args: unknown) => tools.get(name).execute("call", args, undefined, undefined, ctx);
	const baseline = (overrides: object = {}) => tool("autoresearch_baseline", {
		methodology: "Clean compilation of the fixed project inputs. Clear build outputs before each run; measure wall time in milliseconds. Three repetitions, median. Keep correctness checks unchanged.",
		command: "bash measure.sh", checkCommand: "check", files: ["measure.sh"], repetitions: 3,
		metrics: [{ name: "compile_ms", label: "Compile", unit: "ms", direction: "lower" }], ...overrides,
	});
	const enter = async () => {
		const message = messages.findLast(message => message.customType === ITERATION);
		await emit("before_agent_start", { messageType: "custom", message });
	};
	const settle = async (aborted = false) => {
		idle = true; await emit("agent_before_settle", { outcome: aborted ? "aborted" : "completed" }); await emit("agent_settled", { aborted });
	};
	return { directory, ctx, pi, commands, entries, messages, statuses, emit, state, tool, baseline, enter, settle,
		command: (text: string) => commands.get("autoresearch").handler(text, ctx),
		idle: (value: boolean) => { idle = value; }, queued: (value: boolean) => { queued = value; },
		values: (next: number[]) => { values = next; },
		cleanup: async () => { await emit("session_shutdown"); await rm(directory, { recursive: true, force: true }); },
	};
}
afterEach(() => { vi.useRealTimers(); });

it("prepares a real baseline proposal and never dispatches optimization until an explicit approval", async () => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		await h.command("optimize compilation speed --max 2");
		await vi.advanceTimersByTimeAsync(1); await h.enter();
		expect(h.messages[0].content).toContain("do not optimize the implementation yet");
		await expect(h.tool("autoresearch_measure", {})).rejects.toThrow("owned");
		const result = await h.baseline();
		expect(result.content[0].text).toContain("/autoresearch approve");
		expect(result.content[0].text).toContain("Clean compilation");
		expect(h.state()).toMatchObject({ campaign: { state: "awaiting_approval", iterations: 0, baseline: { values: { compile_ms: 100 } } }, report: { provenance: "tool-measured" } });
		expect(h.ctx.executeTool).toHaveBeenCalledTimes(4);
		await h.settle(); await vi.advanceTimersByTimeAsync(60_000);
		expect(h.messages.filter(message => message.customType === ITERATION)).toHaveLength(1);
		await h.command("approve"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		expect(h.state()?.campaign).toMatchObject({ state: "running", iterations: 1 });
		expect(h.messages.at(-1).content).toContain("Autoresearch iteration 1/2");
		h.values([80, 85, 75]); await h.tool("autoresearch_measure", {});
		expect(h.state()?.report?.metrics[0]).toMatchObject({ baseline: 100, value: 80 });
		await expect(h.tool("autoresearch_update", { phase: "checking", message: "Fake score", metrics: [{ name: "compile_ms", value: 1 }] })).rejects.toThrow("must come from");
		await h.settle(); await vi.advanceTimersByTimeAsync(1); await h.enter();
		h.values([70, 75, 65]); await h.tool("autoresearch_measure", {}); await h.settle();
		await vi.advanceTimersByTimeAsync(1);
		expect(h.state()?.campaign).toMatchObject({ state: "complete", iterations: 2 });
		expect(h.messages.filter(message => message.customType === ITERATION)).toHaveLength(3);
	} finally { await h.cleanup(); expect(vi.getTimerCount()).toBe(0); }
});

it("shows each metric's median, range, and sample count, and the objective's noise verdict", async () => {
	vi.useFakeTimers(); const h = await fixture();
	const text = async (work: Promise<{ content: { text: string }[] }>) => (await work).content[0]!.text;
	try {
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		const proposed = await text(h.baseline());
		expect(proposed).toContain("Baseline samples: [{\"compile_ms\":100},{\"compile_ms\":110},{\"compile_ms\":90}]\nCompile: baseline 100 ms (range 90–110 ms, n=3)\n");
		await h.settle(); await h.command("status");
		expect(h.messages.at(-1).content).toContain("Compile: baseline 100 ms (range 90–110 ms, n=3)");
		await h.command("approve"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		const iteration = h.messages.findLast(message => message.customType === ITERATION).content;
		expect(iteration).toContain("\"within noise\" (the baseline and latest ranges overlap) is no measurable difference, not an improvement. With fewer than 2 repetitions noise cannot be estimated (\"noise unknown\"); say so when reporting a change.");
		expect(iteration).toContain("Compile: baseline 100 ms (range 90–110 ms, n=3)");
		h.values([80, 85, 75]); const outside = await text(h.tool("autoresearch_measure", {}));
		expect(outside).toContain("| Compile | objective | lower | 100 ms | 80 ms | -20% |");
		expect(outside).toContain("\n\nCompile: baseline 100 ms (range 90–110 ms, n=3); latest 80 ms (range 75–85 ms, n=3)\nNoise check for Compile (objective): outside noise.");
		h.values([95, 100, 105]); const within = await text(h.tool("autoresearch_measure", {}));
		expect(within).toContain("Compile: baseline 100 ms (range 90–110 ms, n=3); latest 100 ms (range 95–105 ms, n=3)\nNoise check for Compile (objective): within noise.");
		await h.settle();
	} finally { await h.cleanup(); }
	const once = await fixture();
	try {
		await once.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await once.enter();
		expect(await text(once.baseline({ repetitions: 1 }))).toContain("Compile: baseline 100 ms (range 100–100 ms, n=1)");
		await once.settle(); await once.command("approve"); await vi.advanceTimersByTimeAsync(1); await once.enter();
		once.values([80]);
		expect(await text(once.tool("autoresearch_measure", {})))
			.toContain("Compile: baseline 100 ms (range 100–100 ms, n=1); latest 80 ms (range 80–80 ms, n=1)\nNoise check for Compile (objective): noise unknown.");
		await once.settle();
	} finally { await once.cleanup(); }
});

it("shows every metric's range with its own label and unit and judges noise on the objective only", async () => {
	vi.useFakeTimers(); const h = await fixture();
	const text = async (work: Promise<{ content: { text: string }[] }>) => (await work).content[0]!.text;
	let runs: string[] = [];
	const outputs = (rows: [number, number, number][]) => { runs = rows.map(([size, compile, ratio]) => `METRIC size_b=${size}\nMETRIC compile_ms=${compile}\nMETRIC ratio=${ratio}`); };
	vi.mocked(h.ctx.executeTool).mockImplementation(async (_name, input) => ({
		isError: false, result: { content: [{ type: "text", text: (input as { command: string }).command === "check" ? "checks passed" : runs.shift()! }], details: undefined },
	}) as any);
	const verdicts = (result: string) => result.split("\n").filter(line => /noise/.test(line));
	const baseline = [
		"Bundle size: baseline 1,234,560 B (range 1,234,500–1,234,600 B, n=4)",
		"Compile: baseline 105 ms (range 90–120 ms, n=4)",
		"Hit ratio: baseline 0.25 (range 0.123457–0.5, n=4)",
	];
	try {
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		outputs([[1234567.891, 100, 0.123456789], [1234600, 110, 0.5], [1234500, 90, 0.25], [1234550, 120, 0.25]]);
		const proposed = await text(h.baseline({ repetitions: 4, metrics: [
			{ name: "size_b", label: "Bundle size", unit: "B", direction: "lower", role: "constraint" },
			{ name: "compile_ms", label: "Compile", unit: "ms", direction: "lower", role: "objective" },
			{ name: "ratio", label: "Hit ratio", direction: "higher" },
		] }));
		expect(proposed).toContain(baseline.join("\n"));
		expect(verdicts(proposed)).toEqual([]);
		await h.settle(); await h.command("status");
		expect(h.messages.at(-1).content).toContain(baseline.join("\n"));
		await h.emit("session_start", { reason: "reload" }); await h.command("status");
		expect(h.messages.at(-1).content).toContain(baseline.join("\n"));
		await h.command("approve"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		expect(h.messages.findLast(message => message.customType === ITERATION).content).toContain(baseline.join("\n"));

		outputs([[2000, 100, 0.9], [2100, 104, 0.9], [2200, 106, 0.9], [2300, 118, 0.9]]);
		const within = await text(h.tool("autoresearch_measure", {}));
		expect(within.startsWith(`${renderReport(h.state()!.report!)}\n\n`)).toBe(true);
		expect(within).toContain([
			"Bundle size: baseline 1,234,560 B (range 1,234,500–1,234,600 B, n=4); latest 2,150 B (range 2,000–2,300 B, n=4)",
			"Compile: baseline 105 ms (range 90–120 ms, n=4); latest 105 ms (range 100–118 ms, n=4)",
			"Hit ratio: baseline 0.25 (range 0.123457–0.5, n=4); latest 0.9 (range 0.9–0.9, n=4)",
		].join("\n"));
		expect(verdicts(within)).toEqual(["Noise check for Compile (objective): within noise."]);

		outputs([[1234567.891, 50, 0.25], [1234600, 60, 0.25], [1234500, 70, 0.25], [1234550, 80, 0.25]]);
		const outside = await text(h.tool("autoresearch_measure", {}));
		expect(outside).toContain("Bundle size: baseline 1,234,560 B (range 1,234,500–1,234,600 B, n=4); latest 1,234,560 B (range 1,234,500–1,234,600 B, n=4)\nCompile: baseline 105 ms (range 90–120 ms, n=4); latest 65 ms (range 50–80 ms, n=4)\n");
		expect(verdicts(outside)).toEqual(["Noise check for Compile (objective): outside noise."]);

		const stored = h.state()!;
		expect(stored.version).toBe(2);
		expect(Object.keys(stored.campaign!.latest!).sort()).toEqual(["samples", "timestamp", "values"]);
		expect(stored.campaign!.latest!.samples).toEqual([50, 60, 70, 80].map((compile_ms, index) => ({ size_b: [1234567.891, 1234600, 1234500, 1234550][index], compile_ms, ratio: 0.25 })));
		expect(() => restoreState(stored)).not.toThrow();
		await h.settle();
	} finally { await h.cleanup(); }
});

it("describes the range and noise output in the README", async () => {
	const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
	for (const phrase of ["within noise", "outside noise", "noise unknown", "autoresearch_measure", "/autoresearch status", "not a significance test", "1 time in 10"]) expect(readme).toContain(phrase);
	expect(readme).toMatch(/min–max range, and sample count/);
	expect(readme).toMatch(/fewer than 2 samples/);
});

it("rejects approval before a baseline, pins the harness, and requires fresh review after revision", async () => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		await expect(h.command("approve")).rejects.toThrow("baseline");
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter(); await h.baseline(); await h.settle();
		await writeFile(join(h.directory, "measure.sh"), "echo changed\n");
		await expect(h.command("approve")).rejects.toThrow("harness changed");
		await h.command("revise use a clean build, excluding dependency installation");
		expect(h.state()?.campaign).toMatchObject({ state: "preparing", iterations: 0, reason: "use a clean build, excluding dependency installation" });
		expect(h.state()?.campaign?.approved).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1); await h.enter(); await h.baseline(); await h.settle();
		expect(h.state()?.campaign?.state).toBe("awaiting_approval");
		await h.command("approve"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		const moved = await mkdtemp(join(tmpdir(), "pi-autoresearch-other-project-"));
		try {
			await writeFile(join(moved, "measure.sh"), "echo changed\n");
			Object.assign(h.ctx, { cwd: moved });
			await expect(h.tool("autoresearch_measure", {})).rejects.toThrow("working directory changed");
		} finally { Object.assign(h.ctx, { cwd: h.directory }); await rm(moved, { recursive: true, force: true }); }
		await writeFile(join(h.directory, "measure.sh"), "echo changed again\n");
		await expect(h.tool("autoresearch_measure", {})).rejects.toThrow("harness changed");
		await h.settle(); expect(h.state()?.campaign?.state).toBe("paused");
	} finally { await h.cleanup(); }
});

it("waits outside the message queue, cancels stale dispatches, and pauses on user input", async () => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		h.queued(true); await h.command("compile faster"); await vi.advanceTimersByTimeAsync(5000); expect(h.messages).toHaveLength(0);
		h.queued(false); await vi.advanceTimersByTimeAsync(1000); expect(h.messages).toHaveLength(1);
		await h.command("stop"); await h.enter(); expect(h.ctx.abort).toHaveBeenCalledOnce();
		await h.settle();
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		await h.emit("message_start", { message: { role: "user", content: "change the target" } });
		expect(h.state()?.campaign?.state).toBe("paused");
		await expect(h.baseline()).rejects.toThrow("owned");
		await h.settle(); await vi.advanceTimersByTimeAsync(5000); expect(h.messages).toHaveLength(2);
	} finally { await h.cleanup(); }
});

it.each(["before_agent_start", "message_start"])("user input via %s cancels continuation pending between passes", async eventName => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter(); await h.baseline(); await h.settle();
		await h.command("approve"); await vi.advanceTimersByTimeAsync(1); await h.enter(); await h.tool("autoresearch_measure", {}); await h.settle();
		// The next iteration is pending, with no active research pass yet.
		h.idle(false);
		await h.emit(eventName, eventName === "before_agent_start"
			? { messageType: "user", prompt: "Explain the last result" }
			: { message: { role: "user", content: "Explain the last result" } });
		expect(h.state()?.campaign?.state).toBe("paused");
		await h.settle(); await vi.advanceTimersByTimeAsync(1000);
		expect(h.messages.filter(message => message.customType === ITERATION)).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(0);
		await h.command("resume"); await vi.advanceTimersByTimeAsync(1);
		expect(h.messages.filter(message => message.customType === ITERATION)).toHaveLength(3);
	} finally { await h.cleanup(); }
});

it("invalidates in-flight measurements on pause and restores an awaiting proposal without running it", async () => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		let release!: () => void;
		const wait = new Promise<void>(resolve => { release = resolve; });
		vi.mocked(h.ctx.executeTool).mockImplementationOnce(async () => { await wait; return { result: { content: [{ type: "text", text: "METRIC compile_ms=100" }], details: undefined }, isError: false } as any; });
		const pending = h.baseline();
		// fingerprint is asynchronous; wait until the nested command starts.
		await vi.waitFor(() => expect(h.ctx.executeTool).toHaveBeenCalled(), { interval: 1 });
		await h.command("pause"); release(); await expect(pending).rejects.toThrow("interrupted");
		expect(h.state()?.campaign?.baseline).toBeUndefined(); await h.settle();
		await h.command("resume"); await vi.advanceTimersByTimeAsync(1); await h.enter(); await h.baseline(); await h.settle();
		await h.emit("session_start", { reason: "reload" }); await vi.advanceTimersByTimeAsync(1000);
		expect(h.state()?.campaign?.state).toBe("awaiting_approval");
		expect(vi.getTimerCount()).toBe(0);
		await h.command("approve"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		await h.emit("session_start", { reason: "reload" });
		await expect(h.tool("autoresearch_measure", {})).rejects.toThrow("owned");
		await h.command("resume"); expect(vi.getTimerCount()).toBe(1);
	} finally { await h.cleanup(); }
});

it("does not accept failed checks as a baseline, stops unmeasured passes, and rejects headless scheduling", async () => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		vi.mocked(h.ctx.executeTool).mockResolvedValueOnce({ isError: true, result: { content: [{ type: "text", text: "permission denied" }], details: undefined } } as any);
		await expect(h.baseline()).rejects.toThrow("command failed");
		await h.settle(); expect(h.state()?.campaign?.state).toBe("paused");
		await h.command("resume"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		await h.emit("session_tree"); await expect(h.baseline()).rejects.toThrow("owned");
		expect(vi.getTimerCount()).toBe(0);
	} finally { await h.cleanup(); }
	const child = await fixture("print");
	try { await expect(child.command("compile faster")).rejects.toThrow("TUI or RPC"); expect(vi.getTimerCount()).toBe(0); }
	finally { await child.cleanup(); }
});

it.each(["missing path", "unreadable file"])("rejects truncated benchmark output with a %s", async failure => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		vi.mocked(h.ctx.executeTool).mockResolvedValueOnce({
			isError: false,
			result: {
				content: [{ type: "text", text: "METRIC compile_ms=1" }],
				details: { truncation: { truncated: true }, ...(failure === "unreadable file" ? { fullOutputPath: join(h.directory, "missing-output.txt") } : {}) },
			},
		} as any);
		await expect(h.baseline()).rejects.toThrow(failure === "missing path" ? "truncated without a full output file" : "ENOENT");
		expect(h.state()?.campaign?.baseline).toBeUndefined();
		await h.settle(); expect(h.state()?.campaign?.state).toBe("paused");
	} finally { await h.cleanup(); }
});

it("pauses when a failed latest measurement follows an earlier successful measurement", async () => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter(); await h.baseline(); await h.settle();
		await h.command("approve"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		h.values([80, 80, 80]); await h.tool("autoresearch_measure", {});
		vi.mocked(h.ctx.executeTool).mockImplementation(async (_name, input) => ({
			isError: (input as { command: string }).command === "check",
			result: { content: [{ type: "text", text: (input as { command: string }).command === "check" ? "correctness failed" : "METRIC compile_ms=1" }], details: undefined },
		}) as any);
		await expect(h.tool("autoresearch_measure", {})).rejects.toThrow("correctness failed");
		await h.settle(); await vi.advanceTimersByTimeAsync(10_000);
		expect(h.state()?.campaign?.state).toBe("paused");
		expect(h.state()?.report?.metrics[0]?.value).toBe(80);
		expect(h.messages.filter(message => message.customType === ITERATION)).toHaveLength(2);
	} finally { await h.cleanup(); }
});

it("times out an unstarted pass and pauses when the approved campaign lifetime expires", async () => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(30_001);
		expect(h.state()?.campaign?.state).toBe("paused");
		expect(vi.getTimerCount()).toBe(0);
		await h.enter(); expect(h.ctx.abort).toHaveBeenCalledOnce();
		h.idle(true); await h.command("resume"); await vi.advanceTimersByTimeAsync(1); await h.enter(); await h.baseline(); await h.settle();
		await h.command("approve");
		// Pending human work holds dispatch outside Pi's queue until the lifetime expires.
		h.queued(true); vi.setSystemTime(h.state()!.campaign!.deadline! - 1); await vi.advanceTimersByTimeAsync(1000);
		expect(h.state()?.campaign).toMatchObject({ state: "paused", reason: "Six-hour research limit reached." });
		expect(h.messages.filter(message => message.customType === ITERATION)).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(0);
	} finally { await h.cleanup(); }
});

it.each([
	{ stage: "dispatch", recovery: "stop" }, { stage: "dispatch", recovery: "clear" },
	{ stage: "timeout", recovery: "stop" }, { stage: "timeout", recovery: "clear" },
])("scheduler $stage write failure halts ownership and permits $recovery recovery", async ({ stage, recovery }) => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		await h.command("compile faster");
		if (stage === "timeout") { await vi.advanceTimersByTimeAsync(1); await h.enter(); }
		vi.mocked(h.pi.appendEntry).mockImplementationOnce(() => { throw new Error("disk full"); });
		await vi.advanceTimersByTimeAsync(stage === "dispatch" ? 1 : 30 * 60_000);
		expect(vi.getTimerCount()).toBe(0);
		expect(h.ctx.abort).toHaveBeenCalledTimes(stage === "timeout" ? 1 : 0);
		expect(h.statuses.get("autoresearch")).toContain("state error");
		await expect(h.baseline()).rejects.toThrow("owned");
		if (recovery === "clear") {
			await h.commands.get("research-report").handler("clear", h.ctx);
			expect(h.state()?.campaign).toBeNull();
		} else {
			await h.command("stop");
			expect(h.state()?.campaign?.state).toBe("stopped");
		}
		expect(vi.getTimerCount()).toBe(0);
		h.idle(true); await h.command("a new research target");
		expect(h.state()?.campaign?.state).toBe("preparing");
	} finally { await h.cleanup(); }
});

it("stop aborts an owned pass even if recording the stop fails", async () => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		vi.mocked(h.pi.appendEntry).mockImplementationOnce(() => { throw new Error("disk full"); });
		await expect(h.command("stop")).rejects.toThrow("disk full");
		expect(h.ctx.abort).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		await expect(h.baseline()).rejects.toThrow("owned");
		await h.command("stop"); expect(h.state()?.campaign?.state).toBe("stopped");
	} finally { await h.cleanup(); }
});

it("validates the approval record and finite, complete metric output", async () => {
	vi.useFakeTimers(); const h = await fixture();
	try {
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter(); await h.baseline(); await h.settle(); await h.command("approve");
		const state = h.state()!;
		expect(restoreState(state).campaign?.approved).toBe(approvalKey(state));
		const changed = structuredClone(state); changed.campaign!.benchmark!.command = "echo fake";
		expect(() => restoreState(changed)).toThrow("Approval");
		const largerBudget = structuredClone(state); largerBudget.campaign!.maxIterations++;
		expect(() => restoreState(largerBudget)).toThrow("Approval");
		const unmeasured = structuredClone(state);
		Object.assign(unmeasured.campaign!, { state: "paused", baseline: undefined, latest: undefined, approved: undefined, deadline: undefined });
		expect(() => restoreState(unmeasured)).toThrow("Missing baseline proposal");
		for (const text of ["", "METRIC compile_ms=NaN", "METRIC compile_ms=1\nMETRIC compile_ms=2"]) expect(() => parseMetrics(text, ["compile_ms"])).toThrow();
	} finally { await h.cleanup(); }
});

it("keeps the exact harness error messages for approval and measurement", async () => {
	vi.useFakeTimers(); const h = await fixture();
	const message = (work: Promise<unknown>) => work.then(() => "", (error: Error) => error.message);
	try {
		await h.command("compile faster"); await vi.advanceTimersByTimeAsync(1); await h.enter(); await h.baseline(); await h.settle();
		await writeFile(join(h.directory, "measure.sh"), "echo changed\n");
		expect(await message(h.command("approve"))).toBe("Benchmark harness changed. Prepare a new baseline and obtain approval again.");
		await writeFile(join(h.directory, "measure.sh"), "printf 'METRIC compile_ms=100\\n'\n");
		await h.command("approve"); await vi.advanceTimersByTimeAsync(1); await h.enter();
		const moved = await mkdtemp(join(tmpdir(), "pi-autoresearch-other-project-"));
		try {
			Object.assign(h.ctx, { cwd: moved });
			expect(await message(h.tool("autoresearch_measure", {}))).toBe("Research working directory changed. Prepare and approve a new baseline.");
		} finally { Object.assign(h.ctx, { cwd: h.directory }); await rm(moved, { recursive: true, force: true }); }
		await writeFile(join(h.directory, "measure.sh"), "echo changed again\n");
		expect(await message(h.tool("autoresearch_measure", {}))).toBe("Benchmark harness changed. Prepare a new baseline and obtain approval again.");
	} finally { await h.cleanup(); }
});

it("restores a pinned version-2 running campaign with an unchanged approval key", () => {
	const pinned: State = {
		version: 2,
		report: {
			id: "pinned-report", phase: "checking", message: "Candidate measured with the approved methodology.",
			metrics: [{ name: "compile_ms", label: "Compile", unit: "ms", direction: "lower", role: "objective", baseline: 100, value: 80 }],
			updatedAt: 1_760_000_600_000, provenance: "tool-measured",
		},
		campaign: {
			id: "pinned-campaign", goal: "optimize compilation speed", state: "running",
			benchmark: {
				root: "/project", methodology: "Clean compilation of the fixed project inputs; wall time in milliseconds; median of three runs.",
				command: "bash measure.sh", checkCommand: "npm test",
				files: { "measure.sh": "faa261f4dd84ddd7d35e3e76a35ceeac2046006d5a17a60a7c0b00381ba97a60" }, repetitions: 3, timeoutSeconds: 120,
			},
			baseline: { samples: [{ compile_ms: 100 }, { compile_ms: 110 }, { compile_ms: 90 }], values: { compile_ms: 100 }, timestamp: 1_760_000_000_000 },
			latest: { samples: [{ compile_ms: 80 }, { compile_ms: 85 }, { compile_ms: 75 }], values: { compile_ms: 80 }, timestamp: 1_760_000_600_000 },
			approved: "6a5dd77b70acaad762d724e90e7017834f4d02186e76892d3c672f10137cae29",
			iterations: 1, maxIterations: 25, deadline: 1_760_021_700_000,
		},
	};
	expect(approvalKey(pinned)).toBe("6a5dd77b70acaad762d724e90e7017834f4d02186e76892d3c672f10137cae29");
	expect(() => restoreState(pinned)).not.toThrow();
});
