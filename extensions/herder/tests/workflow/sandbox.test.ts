import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/config.ts";
import type { AgentOptions, IntegrateOptions, IntegrateResult, Limits, StepResult, WorkflowBridge } from "../../src/types.ts";
import { runScript, startSandbox, syntaxProblem } from "../../src/workflow/sandbox.ts";
import type { ScriptOutcome } from "../../src/workflow/sandbox.ts";

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const ok = (key: string, extra: Partial<StepResult> = {}): StepResult => ({ status: "ok", key, text: `text ${key}`, reused: false, ...extra });

class FakeBridge implements WorkflowBridge {
	agents: { prompt: string; opts: AgentOptions }[] = [];
	integrations: { source: StepResult | string; opts: IntegrateOptions }[] = [];
	events: string[] = [];
	active = 0; maxActive = 0; activeWriters = 0; maxWriters = 0;
	private waiters: { check(): boolean; resolve(): void }[] = [];
	constructor(readonly answer: (prompt: string, opts: AgentOptions, index: number) => Promise<StepResult> | StepResult = (prompt, _opts, index) => ok(`k${index}`)) {}
	async agent(prompt: string, opts: AgentOptions): Promise<StepResult> {
		const index = this.agents.length;
		this.agents.push({ prompt, opts });
		this.event(`start:${prompt}`);
		const write = opts.write !== false;
		this.active++;
		if (write) this.activeWriters++;
		this.maxActive = Math.max(this.maxActive, this.active);
		this.maxWriters = Math.max(this.maxWriters, this.activeWriters);
		try { return await this.answer(prompt, opts, index); }
		finally {
			this.active--;
			if (write) this.activeWriters--;
			this.event(`end:${prompt}`);
		}
	}
	async integrate(source: StepResult | string, opts: IntegrateOptions): Promise<IntegrateResult> {
		this.integrations.push({ source, opts });
		return { status: "integrated", head: "a".repeat(40) };
	}
	log(message: string) { this.event(`log:${message}`); }
	phase(title: string) { this.event(`phase:${title}`); }
	/** Resolves once `check` holds; rechecked on every bridge event, so tests wait on progress rather than the clock. */
	until(check: () => boolean): Promise<void> {
		if (check()) return Promise.resolve();
		return new Promise(resolve => this.waiters.push({ check, resolve }));
	}
	private event(event: string) {
		this.events.push(event);
		this.waiters = this.waiters.filter(waiter => !(waiter.check() && (waiter.resolve(), true)));
	}
}

function run(source: string, bridge: WorkflowBridge = new FakeBridge(), extra: { args?: unknown; limits?: Partial<Limits> } = {}) {
	return runScript({
		source, args: extra.args, bridge, limits: { ...LIMITS, ...extra.limits },
		writes: (_role, write) => write !== false,
	});
}
const outcome = (source: string, bridge?: WorkflowBridge, extra?: { args?: unknown; limits?: Partial<Limits> }): Promise<ScriptOutcome> => run(source, bridge, extra).done;
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

describe("script runtime", () => {
	it("forwards agent and integrate calls with their options and returns the result", async () => {
		const bridge = new FakeBridge();
		const result = await outcome(`
			phase("Build");
			log("starting");
			const step = await agent("do it", { id: "impl", role: "worker", gate: ["unit"], schema: { type: "object" }, timeoutMs: 5, task: "T1", base: undefined });
			const merged = await integrate(step, { message: "feat: x", task: "T1", checks: ["unit"] });
			const direct = await integrate("abc123", { message: "raw" });
			return { step, merged, direct, args, isArray: Array.isArray(args.list), proto: Object.getPrototypeOf(step) === Object.prototype };
		`, bridge, { args: { list: [1, 2] } });
		expect(result.status).toBe("completed");
		expect(bridge.agents).toEqual([{ prompt: "do it", opts: { id: "impl", role: "worker", gate: ["unit"], schema: { type: "object" }, timeoutMs: 5, task: "T1" } }]);
		expect(bridge.integrations).toEqual([
			{ source: ok("k0"), opts: { message: "feat: x", task: "T1", checks: ["unit"] } },
			{ source: "abc123", opts: { message: "raw" } },
		]);
		expect(bridge.events.slice(0, 2)).toEqual(["phase:Build", "log:starting"]);
		expect(result.value).toEqual({
			step: ok("k0"), merged: { status: "integrated", head: "a".repeat(40) }, direct: { status: "integrated", head: "a".repeat(40) },
			args: { list: [1, 2] }, isArray: true, proto: true,
		});
	});

	it("delivers log and phase calls in order", async () => {
		const bridge = new FakeBridge();
		await outcome(`phase("A"); log("1"); log({ n: 2 }); phase("B"); await agent("x"); log("3");`, bridge);
		expect(bridge.events).toEqual(["phase:A", "log:1", 'log:{"n":2}', "phase:B", "start:x", "end:x", "log:3"]);
	});

	it.each([
		["Date.now()", "Date.now()"],
		["Math.random()", "Math.random()"],
		["new Date()", "new Date()"],
		["new globalThis.Date()", "new Date()"],
		["new (new Date(0).constructor)()", "new Date()"],
		["Date()", "Date()"],
		["new (class extends Date {})()", "new Date()"],
	])("makes %s throw", async (expression, name) => {
		const result = await outcome(`return ${expression};`);
		expect(result.status).toBe("failed");
		expect(result.error).toContain(`${name} is unavailable`);
		expect(result.line).toBe(1);
	});

	it("keeps Date with explicit arguments", async () => {
		const result = await outcome(`
			class Day extends Date {}
			return [new Date(0).toISOString(), Date.UTC(2020, 0, 1), new Date("2020-01-02").getTime(), Date.parse("2020-01-02"),
				new Date(0) instanceof Date, new Date(0).constructor === Date, Date.name, new Day(5).getTime(), new Day(5) instanceof Date,
				new Date(0).toLocaleDateString("en-US", { timeZone: "UTC" }),
				Object.getPrototypeOf(Date) === Function.prototype, Object.getPrototypeOf(Date.prototype) === Object.prototype];
		`);
		expect(result).toEqual({ status: "completed", value: ["1970-01-01T00:00:00.000Z", 1577836800000, 1577923200000, 1577923200000, true, true, "Date", 5, true, "1/1/1970", true, true] });
	});

	it("exposes no clock, randomness, or garbage-collection timing", async () => {
		const result = await outcome(`return ["performance", "crypto", "WeakRef", "FinalizationRegistry", "setInterval", "queueMicrotask", "Atomics", "SharedArrayBuffer"].filter(name => typeof globalThis[name] !== "undefined");`);
		expect(result).toEqual({ status: "completed", value: [] });
	});

	it("exposes nothing that allocates memory outside the heap limit", async () => {
		const result = await outcome(`return Object.getOwnPropertyNames(globalThis).filter(name => /Array|Buffer|DataView|Atomics|WebAssembly|Intl|Temporal/.test(name));`);
		expect(result).toEqual({ status: "completed", value: ["Array"] });
	});

	it.each([
		["eval('1')"],
		["new Function('return 1')()"],
		["agent.constructor('return 1')()"],
		["log.constructor('return 1')()"],
		["agent('x').constructor.constructor('return 1')()"],
		["(await parallel([])).constructor.constructor('return 1')()"],
		["(await agent('x').catch(e => e)).constructor.constructor('return 1')()"],
		["(await agent('', {}).catch(e => e)).constructor.constructor('return 1')()"],
		["globalThis.constructor.constructor('return 1')()"],
		["Object.getPrototypeOf(globalThis).constructor.constructor('return 1')()"],
		["(async () => {}).constructor('return 1')()"],
	])("blocks code generation: %s", async expression => {
		const result = await outcome(`return ${expression};`);
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/Code generation from strings disallowed/);
	});

	it("builds every value the script can reach from the sandbox's own constructors", async () => {
		const bridge = new FakeBridge((prompt) => {
			if (prompt === "reject") throw new Error("host failure");
			return ok(prompt, { data: { nested: [{ deep: true }] }, checks: [] });
		});
		const result = await outcome(`
			const roots = { args, agent, integrate, parallel, pipeline, phase, log, globalThis };
			roots.invalid = await agent("").catch((e) => e);
			roots.unknown = await agent("x", { nope: 1 }).catch((e) => e);
			roots.rejected = await agent("reject").catch((e) => e);
			roots.capped = await parallel(Array.from({ length: 3 }, () => () => 1)).catch((e) => e);
			roots.step = await agent("ok");
			roots.pending = agent("ok2");
			roots.awaited = await roots.pending;
			roots.merged = await integrate(roots.step, { message: "m" });
			roots.fanned = await parallel([() => agent("p"), () => { throw new Error("thunk"); }]);
			roots.piped = await pipeline([1], (prev) => agent("q" + prev));
			roots.logged = log("x");
			roots.phased = phase("y");
			const seen = new Set(), bad = [];
			const blocked = (fn) => { try { fn("return 1"); return false; } catch (error) { return /Code generation/.test(String(error && error.message)); } };
			const visit = (value, path, depth) => {
				if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value) || depth > 6) return;
				seen.add(value);
				let ctor;
				try { ctor = value.constructor; } catch { ctor = undefined; }
				if (typeof ctor === "function" && !blocked(ctor.constructor)) bad.push(path);
				if (typeof value === "function" && !blocked(value.constructor)) bad.push(path + "()");
				visit(Object.getPrototypeOf(value), path + ".__proto__", depth + 1);
				for (const key of Reflect.ownKeys(value)) {
					let child;
					try { child = value[key]; } catch { continue; }
					visit(child, path + "." + String(key), depth + 1);
				}
			};
			visit(roots, "roots", 0);
			return bad;
		`, bridge, { args: { list: [{ a: 1 }] }, limits: { itemsPerCall: 2 } });
		expect(result).toEqual({ status: "completed", value: [] });
	});

	it.each([
		["require('node:fs')", /require is not defined/],
		["process.env", /process is not defined/],
		["setTimeout(() => {}, 1)", /setTimeout is not defined/],
		["fetch('http://example.com')", /fetch is not defined/],
		["await import('node:fs')", /./],
	])("exposes no host capability: %s", async (expression, error) => {
		const result = await outcome(`return ${expression};`);
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(error);
	});

	it("exposes exactly the script globals", async () => {
		const result = await outcome(`return ["agent", "integrate", "parallel", "pipeline", "phase", "log", "args", "console", "workflow", "budget", "meta"].filter(name => typeof globalThis[name] !== "undefined");`, undefined, { args: {} });
		expect(result.value).toEqual(["agent", "integrate", "parallel", "pipeline", "phase", "log", "args"]);
	});

	it("rejects import, export, and syntax errors with the author's line numbers", async () => {
		expect(await outcome(`import fs from "node:fs";`)).toMatchObject({ status: "failed", line: 1 });
		const broken = await outcome(`const a = 1;\nconst b = ;\nreturn a;`);
		expect(broken).toMatchObject({ status: "failed", line: 2 });
		expect(broken.error).toMatch(/SyntaxError/);
	});

	it("keeps the script inside its function body and clamps lines to the source", async () => {
		const bridge = new FakeBridge();
		const escaped = await outcome(`}); log("outside"); (async () => {`, bridge);
		expect(escaped).toMatchObject({ status: "failed", error: expect.stringMatching(/^SyntaxError/) });
		expect(bridge.events).toEqual([]);
		expect(syntaxProblem(`return 1;\n}\n(async () => {\nreturn 2;`)).toMatchObject({ severity: "error" });
		expect(syntaxProblem(`if (true) {\nlog(1);`)).toMatchObject({ line: 2, message: "SyntaxError: Unexpected end of input" });
		expect(syntaxProblem(`log(1);\n}`)).toMatchObject({ message: "SyntaxError: Unexpected token '}'" });
		expect(await outcome(`if (true) {\nlog(1);`)).toMatchObject({ status: "failed", line: 2 });
		expect(syntaxProblem(`return 1;\n// trailing comment`)).toBeUndefined();
	});

	it("reads call sites from stack frames, not from the message", async () => {
		const result = await outcome(`\nthrow new Error("see herder-script.js:99:3");`);
		expect(result).toMatchObject({ status: "failed", line: 2 });
	});

	it("rebuilds runtime errors with the sandbox's matching constructor", async () => {
		// The circular object defeats JSON and has no toString, so log() fails inside the worker with a TypeError.
		const result = await outcome(`
			const value = { toString: null };
			value.self = value;
			try { log(value); } catch (error) { return [error.name, error instanceof TypeError, error.constructor === TypeError]; }
		`);
		expect(result).toEqual({ status: "completed", value: ["TypeError", true, true] });
	});

	it("fails a script that exceeds its memory limit without affecting the host", async () => {
		const handle = startSandbox({
			source: `const hoard = []; while (true) hoard.push(new Array(100000).fill(1));`, args: undefined, limits: LIMITS,
			host: { call: async () => undefined, log() {}, phase() {} }, resourceLimits: { maxOldGenerationSizeMb: 16 },
		});
		expect(await handle.done).toMatchObject({ status: "failed", error: expect.stringMatching(/memory limit/) });
		expect(await outcome(`return 1;`)).toEqual({ status: "completed", value: 1 });
	});

	it("reports runtime errors with the script line", async () => {
		const result = await outcome(`const a = 1;\n\nthrow new Error("boom");`);
		expect(result).toMatchObject({ status: "failed", line: 3 });
		expect(result.error).toBe("boom (line 3:7)");
		const reference = await outcome(`await agent("x");\nmissing();`);
		expect(reference).toMatchObject({ status: "failed", line: 2 });
	});

	it("tells thrown values apart from runtime failures", async () => {
		expect(await outcome(`throw new TypeError("x");`)).toMatchObject({ status: "failed", exception: { name: "TypeError", fatal: false } });
		expect(await outcome(`throw "plain";`)).toMatchObject({ status: "failed", exception: { fatal: false } });
		expect(await outcome(`await agent("");`)).toMatchObject({ status: "failed", exception: { name: "Error", fatal: true } });
		expect((await outcome(`agent("x"); return 1;`)).exception).toBeUndefined();
		for (const read of ["Date.now()", "Math.random()", "new Date()"]) {
			expect(await outcome(`return ${read};`), read).toMatchObject({ status: "failed", exception: { name: "DeterminismError", fatal: false } });
		}
	});

	it("terminates a runaway loop on stop and ignores late bridge results", async () => {
		const spinning = new FakeBridge();
		const handle = run(`log("spinning"); while (true) {}`, spinning);
		await spinning.until(() => spinning.events.includes("log:spinning"));
		handle.stop("user stop");
		expect(await handle.done).toEqual({ status: "stopped", error: "user stop" });

		const late = deferred<StepResult>();
		const bridge = new FakeBridge(() => late.promise);
		const pending = run(`const r = await agent("slow"); log("after"); return r;`, bridge);
		await bridge.until(() => bridge.agents.length === 1);
		pending.stop();
		late.resolve(ok("late"));
		expect(await pending.done).toMatchObject({ status: "stopped" });
		await tick();
		expect(bridge.events).not.toContain("log:after");
	});

	it("surfaces a rejected bridge call at the script's call site", async () => {
		const bridge = new FakeBridge(() => { throw new Error("cap breach in executor"); });
		const caught = await outcome(`try { await agent("x"); } catch (error) { return [error.message, error instanceof Error]; }`, bridge);
		expect(caught).toEqual({ status: "completed", value: ["cap breach in executor", true] });
		const uncaught = await outcome(`\nawait agent("x");`, bridge);
		expect(uncaught).toMatchObject({ status: "failed", error: "cap breach in executor (line 2:7)", line: 2 });
	});

	it("rejects invalid agent and integrate options at the call site", async () => {
		const cases: [string, RegExp][] = [
			[`await agent("")`, /non-empty string prompt/],
			[`await agent("x", { model: "gpt" })`, /opts\.model is not a recognised option/],
			[`await agent("x", { gate: 3 })`, /opts\.gate must be/],
			[`await agent("x", { schema: "x" })`, /opts\.schema must be a JSON Schema object/],
			[`await agent("x", { timeoutMs: -1 })`, /opts\.timeoutMs must be a positive number/],
			[`await agent("x", { write: "yes" })`, /opts\.write must be a boolean/],
			[`await agent("x", { effort: "huge" })`, /opts\.effort must be one of off, minimal, low, medium, high, xhigh, max/],
			[`await agent("x", [])`, /expects opts to be an object/],
			[`await integrate({ status: "ok" }, { message: "m" })`, /step result \(with a key\) or a commit/],
			[`await integrate("abc", {})`, /opts\.message is required/],
			[`await integrate("abc", { message: "m", squash: true })`, /opts\.squash is not a recognised option/],
			[`await integrate("abc", { message: "m", checks: "unit" })`, /opts\.checks must be an array/],
		];
		for (const [call, error] of cases) {
			const bridge = new FakeBridge();
			const result = await outcome(`\n${call};`, bridge);
			expect(result.status, call).toBe("failed");
			expect(result.error, call).toMatch(error);
			expect(result.line, call).toBe(2);
			expect(bridge.agents.length + bridge.integrations.length, call).toBe(0);
		}
	});

	it("requires a JSON-serializable result and awaited calls", async () => {
		expect(await outcome(`return new Map();`)).toMatchObject({ status: "failed", error: expect.stringMatching(/non-plain object/) });
		expect(await outcome(`return undefined;`)).toEqual({ status: "completed" });
		const late = deferred<StepResult>();
		const result = await outcome(`agent("x"); return 1;`, new FakeBridge(() => late.promise));
		expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/still pending/), line: 1 });
		const unawaited = await outcome(`\nagent("");\nawait agent("y");\nreturn 1;`);
		expect(unawaited).toMatchObject({ status: "failed", line: 2 });
	});

	it("decides the unawaited-call rule in the worker, independent of host speed", async () => {
		const source = `\nagent("x");\nreturn (await agent("y")).key;`;
		const fast = await outcome(source, new FakeBridge());
		const late = deferred<StepResult>();
		const slow = await outcome(source, new FakeBridge(prompt => prompt === "x" ? late.promise : ok("y")));
		expect(fast).toMatchObject({ status: "failed", line: 2, error: expect.stringMatching(/never awaited/) });
		expect(slow).toEqual(fast);
		for (const awaited of [
			`const p = agent("x"); await agent("y"); return (await p).key;`,
			`const [a] = await Promise.all([agent("x"), agent("y")]); return a.key;`,
			`return agent("x").then(r => r.key);`,
			`await parallel([() => agent("x"), () => agent("y")]); return "k0";`,
		]) {
			const results = await Promise.all([outcome(awaited, new FakeBridge()), outcome(awaited, new FakeBridge(async () => { await tick(5); return ok("k0"); }))]);
			expect(results, awaited).toEqual([{ status: "completed", value: "k0" }, { status: "completed", value: "k0" }]);
		}
	});
});

describe("parallel and pipeline", () => {
	it("parallel is a barrier, keeps order, and maps thrown thunks to null", async () => {
		const gates = [deferred<StepResult>(), deferred<StepResult>(), deferred<StepResult>()];
		const bridge = new FakeBridge((prompt) => gates[Number(prompt)]!.promise);
		const handle = run(`
			const results = await parallel([
				() => agent("0").then(r => (log("got 0"), r)),
				async () => { throw new Error("thunk failed"); },
				() => agent("1").then(r => r.key),
				() => agent("2").then(r => (log("got 2"), r)),
				() => { throw new Error("sync failure"); },
			]);
			log("after");
			return results;
		`, bridge);
		await bridge.until(() => bridge.agents.length === 3);
		expect(bridge.agents.map(a => a.prompt)).toEqual(["0", "1", "2"]);
		gates[2]!.resolve(ok("c"));
		gates[0]!.resolve(ok("a"));
		await bridge.until(() => bridge.events.includes("log:got 0") && bridge.events.includes("log:got 2"));
		expect(bridge.events).not.toContain("log:after");
		gates[1]!.resolve(ok("b"));
		const result = await handle.done;
		expect(result).toEqual({ status: "completed", value: [ok("a"), null, "b", ok("c"), null] });
		expect(bridge.events).toContain("log:parallel() item 1 failed: thunk failed");
	});

	it("pipeline has no barrier between stages and drops a failing item to null", async () => {
		const gates = new Map<string, Deferred<StepResult>>();
		const bridge = new FakeBridge((prompt) => {
			const gate = deferred<StepResult>();
			gates.set(prompt, gate);
			return gate.promise;
		});
		const handle = run(`
			return await pipeline(["a", "b", "c"],
				(item, original, index) => agent("s1:" + item + ":" + index),
				async (prev, item) => { if (item === "c") throw new Error("no"); return agent("s2:" + item + ":" + prev.key); },
				(prev, item) => prev.key + "/" + item,
			);
		`, bridge);
		const started = (prompt: string) => () => bridge.agents.some(a => a.prompt === prompt);
		await bridge.until(() => bridge.agents.length === 3);
		expect([...gates.keys()]).toEqual(["s1:a:0", "s1:b:1", "s1:c:2"]);
		gates.get("s1:a:0")!.resolve(ok("A1"));
		await bridge.until(started("s2:a:A1"));
		// Item a reaches stage 2 while b is still in stage 1.
		expect([...gates.keys()]).toContain("s2:a:A1");
		expect(gates.has("s2:b:B1")).toBe(false);
		gates.get("s2:a:A1")!.resolve(ok("A2"));
		gates.get("s1:c:2")!.resolve(ok("C1"));
		gates.get("s1:b:1")!.resolve(ok("B1"));
		await bridge.until(started("s2:b:B1"));
		gates.get("s2:b:B1")!.resolve(ok("B2"));
		expect(await handle.done).toEqual({ status: "completed", value: ["A2/a", "B2/b", null] });
	});

	it("lets fatal errors escape parallel and pipeline", async () => {
		const result = await outcome(`return await parallel([() => agent("ok"), () => agent("x", { bogus: 1 })]);`);
		expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/opts\.bogus/) });
		const viaPipeline = await outcome(`return await pipeline([1], () => integrate("c", {}));`);
		expect(viaPipeline).toMatchObject({ status: "failed", error: expect.stringMatching(/opts\.message is required/) });
	});
});

describe("caps", () => {
	it("throws when a launch exceeds its agent cap", async () => {
		const bridge = new FakeBridge();
		const result = await outcome(`\nfor (let i = 0; i < 5; i++) await agent("a" + i);`, bridge, { limits: { agentsPerLaunch: 3 } });
		expect(result).toMatchObject({ status: "failed", line: 2 });
		expect(result.error).toMatch(/limit of 3 agents per launch/);
		expect(bridge.agents).toHaveLength(3);
	});

	it("throws when parallel or pipeline gets too many items", async () => {
		const limits = { itemsPerCall: 2 };
		expect(await outcome(`await parallel([() => 1, () => 2, () => 3]);`, undefined, { limits })).toMatchObject({ status: "failed", error: expect.stringMatching(/3 items, over the limit of 2/) });
		expect(await outcome(`await pipeline([1, 2, 3], x => x);`, undefined, { limits })).toMatchObject({ status: "failed", error: expect.stringMatching(/over the limit of 2/) });
		expect(await outcome(`return await parallel([() => 1, () => 2]);`, undefined, { limits })).toEqual({ status: "completed", value: [1, 2] });
	});

	it("queues agents beyond the concurrency and writer caps in FIFO order", async () => {
		const gates: Deferred<StepResult>[] = [];
		const bridge = new FakeBridge(() => { const gate = deferred<StepResult>(); gates.push(gate); return gate.promise; });
		const handle = run(`
			return await parallel([
				() => agent("w1"), () => agent("w2"), () => agent("w3"),
				() => agent("r1", { write: false }), () => agent("r2", { write: false }),
			]);
		`, bridge, { limits: { concurrentAgents: 3, concurrentWriters: 2 } });
		await bridge.until(() => bridge.agents.length === 3);
		// w3 waits for a writer slot; r1 takes the free agent slot; r2 waits for any slot.
		expect(bridge.agents.map(a => a.prompt)).toEqual(["w1", "w2", "r1"]);
		gates[2]!.resolve(ok("r1"));
		await bridge.until(() => bridge.agents.length === 4);
		expect(bridge.agents.map(a => a.prompt)).toEqual(["w1", "w2", "r1", "r2"]);
		gates[0]!.resolve(ok("w1"));
		await bridge.until(() => bridge.agents.length === 5);
		expect(bridge.agents.map(a => a.prompt)).toEqual(["w1", "w2", "r1", "r2", "w3"]);
		for (const gate of gates) gate.resolve(ok("x"));
		expect((await handle.done).status).toBe("completed");
		expect(bridge.maxActive).toBe(3);
		expect(bridge.maxWriters).toBe(2);
	});

	it("prepares each agent call when it arrives, before it waits for a slot", async () => {
		const gate = deferred<void>();
		const prepared: string[] = [];
		const received: unknown[] = [];
		let state = "before";
		const bridge = new FakeBridge(async (prompt) => {
			if (prompt === "a") { await gate.promise; state = "after"; }
			return ok(prompt);
		});
		const withPrepare: WorkflowBridge = {
			prepare: (prompt) => { prepared.push(`${prompt}:${state}`); return `${prompt}@${state}`; },
			agent: (prompt, opts, token) => { received.push(token); return bridge.agent(prompt, opts); },
			integrate: (source, opts) => bridge.integrate(source, opts),
			log: (message) => bridge.log(message), phase: (title) => bridge.phase(title),
		};
		const handle = run(`return await parallel([() => agent("a"), () => agent("b")]).then((r) => r.map((x) => x.key));`, withPrepare, { limits: { concurrentAgents: 1 } });
		for (let waited = 0; prepared.length < 2 && waited < 5_000; waited += 5) await tick(5);
		expect(prepared).toEqual(["a:before", "b:before"]);
		expect(bridge.agents.map((call) => call.prompt)).toEqual(["a"]);
		gate.resolve();
		expect(await handle.done).toEqual({ status: "completed", value: ["a", "b"] });
		expect(received).toEqual(["a@before", "b@before"]);
	});

	it("does not start queued agents after a stop", async () => {
		const gate = deferred<StepResult>();
		const bridge = new FakeBridge(() => gate.promise);
		const handle = run(`await parallel([() => agent("a"), () => agent("b")]);`, bridge, { limits: { concurrentAgents: 1 } });
		await bridge.until(() => bridge.agents.length === 1);
		handle.stop();
		gate.resolve(ok("a"));
		await handle.done;
		await tick();
		expect(bridge.agents.map(a => a.prompt)).toEqual(["a"]);
	});
});
