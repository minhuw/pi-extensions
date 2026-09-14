import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const script = readFileSync(new URL("../../../assets/dashboard/dashboard.js", import.meta.url), "utf8");

class Node {
	textContent = "";
	hidden = false;
	title = "";
	id = "";
	className = "";
	dataset: Record<string, string> = {};
	style: Record<string, string> = {};
	attributes: Record<string, string> = {};
	children: Node[] = [];
	listeners: Record<string, () => void> = {};
	classList = { toggle() {} };
	append(...children: Node[]) { this.children.push(...children); }
	replaceChildren(...children: Node[]) { this.children = children; }
	setAttribute(name: string, value: string) { this.attributes[name] = value; }
	addEventListener(name: string, listener: () => void) { this.listeners[name] = listener; }
}

function snapshot(name = "Plans") {
	return {
		version: 2, readOnly: true, generatedAt: "2026-01-01T00:00:00Z",
		planSet: { name, counts: { total: 0 }, ready: [], complete: false },
		plans: [], forecast: { finished: 0, percent: 0, elapsedMs: null, estimatedRemainingMs: null },
		integration: { completedPlans: [], readyPlans: [] },
	};
}

function response(status = 200, etag: string | null = '"one"', body: unknown = snapshot()) {
	let jsonCalls = 0;
	return {
		status, ok: status >= 200 && status < 300,
		headers: { get: (name: string) => name.toLowerCase() === "etag" ? etag : "same-revision" },
		async json() {
			jsonCalls++;
			if (body instanceof Error) throw body;
			return body;
		},
		get jsonCalls() { return jsonCalls; },
	};
}

function browser() {
	const nodes = new Map<string, Node>();
	const node = (id: string) => {
		if (!nodes.has(id)) nodes.set(id, new Node());
		return nodes.get(id)!;
	};
	const requests: Array<{
		url: string; options: { cache: string; headers: Record<string, string> };
		resolve: (value: ReturnType<typeof response>) => void; reject: (error: Error) => void;
	}> = [];
	const intervals: Array<{ callback: () => Promise<void>; delay: number }> = [];
	const rendered: unknown[] = [];
	let renderFailure = false;
	const context = createContext({
		document: {
			getElementById: node, createElement: () => new Node(), createElementNS: () => new Node(),
			createDocumentFragment: () => new Node(), querySelectorAll: () => [], documentElement: new Node(),
		},
		localStorage: { getItem: () => null },
		fetch: (url: string, options: { cache: string; headers: Record<string, string> }) =>
			new Promise<ReturnType<typeof response>>((resolve, reject) => requests.push({ url, options, resolve, reject })),
		setInterval: (callback: () => Promise<void>, delay: number) => intervals.push({ callback, delay }),
		observeRender: (state: unknown) => rendered.push(state),
	});
	runInContext(script, context, { timeout: 1000 });
	// Wrap the real renderer; DOM failure happens late, after earlier render work.
	runInContext("const actualRender = render; render = (state) => { observeRender(state); actualRender(state); }", context, { timeout: 1000 });
	const accountingBody = node("main-content").children[0].children[1];
	const replace = accountingBody.replaceChildren.bind(accountingBody);
	accountingBody.replaceChildren = (...children) => {
		if (renderFailure) { renderFailure = false; throw new Error("render failed"); }
		replace(...children);
	};
	return {
		node, requests, intervals, rendered,
		failRender: () => { renderFailure = true; },
		state: () => runInContext("view.state", context, { timeout: 1000 }),
		tick: () => intervals[0].callback(),
		pause: () => node("refresh-toggle").listeners.click(),
		async reply(value: ReturnType<typeof response> | Error) {
			const request = requests.at(-1)!;
			if (value instanceof Error) request.reject(value);
			else request.resolve(value);
			await setImmediate();
		},
	};
}

function assertRequest(b: ReturnType<typeof browser>, etag?: string) {
	const { url, options } = b.requests.at(-1)!;
	assert.equal(url, "/api/state");
	assert.equal(options.cache, "no-store");
	assert.deepEqual(Object.entries(options.headers), etag ? [["If-None-Match", etag]] : []);
}

function assertLive(b: ReturnType<typeof browser>) {
	assert.equal(b.node("snapshot-state").textContent, "LIVE");
	assert.equal(b.node("connection-toast").hidden, true);
}

function assertStale(b: ReturnType<typeof browser>) {
	assert.equal(b.node("snapshot-state").textContent, "STALE");
	assert.equal(b.node("connection-toast").hidden, false);
	assert.match(b.node("connection-toast").textContent, /Observer disconnected/);
}

test("conditional refresh skips 304 bodies/render, but every 200 renders despite repeated revision", { timeout: 2000 }, async () => {
	const b = browser();
	assert.equal(b.intervals.length, 1);
	assert.equal(b.intervals[0].delay, 2000);
	assertRequest(b);
	const first = response();
	await b.reply(first);
	assert.equal(first.jsonCalls, 1);
	assert.equal(b.rendered.length, 1);
	assertLive(b);

	void b.tick();
	assertRequest(b, '"one"');
	const unchanged = response(304, '"ignored"', new Error("must not parse"));
	await b.reply(unchanged);
	assert.equal(unchanged.jsonCalls, 0);
	assert.equal(b.rendered.length, 1);
	assertLive(b);

	void b.tick();
	assertRequest(b, '"one"');
	const changed = response(200, 'W/"two"', snapshot("Changed"));
	await b.reply(changed);
	assert.equal(changed.jsonCalls, 1);
	assert.equal(b.rendered.length, 2);
	assert.equal(b.node("plan-name").textContent, "Changed");
	void b.tick();
	assertRequest(b, 'W/"two"');
	await b.reply(response(200, null, snapshot("Legacy")));
	void b.tick();
	assertRequest(b);
	await b.reply(response(200, null, snapshot("Legacy again")));
	assert.equal(b.rendered.length, 4);
	assertLive(b);
});

for (const failure of ["fetch", "http", "json", "schema"] as const) {
	test(`${failure} failure retains snapshot and validator; 304 restores LIVE without rendering`, { timeout: 2000 }, async () => {
		const b = browser();
		const retained = snapshot();
		await b.reply(response(200, '"one"', retained));
		void b.tick();
		assertRequest(b, '"one"');
		await b.reply(failure === "fetch" ? new Error("offline") : response(
			failure === "http" ? 503 : 200, '"bad"',
			failure === "json" ? new Error("invalid JSON") : failure === "schema" ? { version: 1, readOnly: true } : snapshot("Unretained"),
		));
		assertStale(b);
		assert.equal(b.state(), retained);
		const renderCount = b.rendered.length;
		void b.tick();
		assertRequest(b, '"one"');
		const unchanged = response(304);
		await b.reply(unchanged);
		assert.equal(unchanged.jsonCalls, 0);
		assert.equal(b.rendered.length, renderCount);
		assertLive(b);
	});
}

test("partial render invalidates the DOM validator and recovers with a full snapshot", { timeout: 2000 }, async () => {
	const b = browser();
	const retained = snapshot();
	await b.reply(response(200, '"one"', retained));
	void b.tick();
	b.failRender();
	await b.reply(response(200, '"bad"', snapshot("Partial")));
	assertStale(b);
	assert.equal(b.state(), retained);
	assert.equal(b.node("plan-name").textContent, "Partial");
	void b.tick();
	assertRequest(b);
	await b.reply(response(304));
	assertStale(b);
	void b.tick();
	assertRequest(b);
	await b.reply(response(200, '"one"', retained));
	assert.equal(b.node("plan-name").textContent, "Plans");
	assertLive(b);
	void b.tick();
	assertRequest(b, '"one"');
	await b.reply(response(304));
	assertLive(b);
});

test("unsolicited 304 and failed initial renders never establish a retained view or validator", { timeout: 2000 }, async () => {
	const b = browser();
	const unchanged = response(304);
	await b.reply(unchanged);
	assertStale(b);
	assert.equal(unchanged.jsonCalls, 0);
	assert.equal(b.state(), null);
	assert.equal(b.rendered.length, 0);
	for (const body of [{ version: 2, readOnly: false }, null, snapshot()]) {
		void b.tick();
		assertRequest(b);
		if (body?.readOnly === true) b.failRender();
		await b.reply(response(200, '"bad"', body));
		assertStale(b);
		assert.equal(b.state(), null);
	}
	void b.tick();
	assertRequest(b);
	await b.reply(response());
	assertLive(b);
	void b.tick();
	assertRequest(b, '"one"');
	await b.reply(response(304));
});

test("polling guards in-flight requests and pause/resume, including pause during a fetch", { timeout: 2000 }, async () => {
	const b = browser();
	await b.tick();
	assert.equal(b.requests.length, 1);
	b.pause();
	await b.tick();
	assert.equal(b.requests.length, 1);
	await b.reply(response());
	assert.equal(b.node("snapshot-state").textContent, "PAUSED");
	assert.equal(b.node("refresh-toggle").attributes["aria-pressed"], "true");
	await b.tick();
	assert.equal(b.requests.length, 1);
	b.pause();
	assert.equal(b.requests.length, 2);
	assertRequest(b, '"one"');
	await b.tick();
	assert.equal(b.requests.length, 2);
	b.pause();
	const renderCount = b.rendered.length;
	await b.reply(response(304));
	assert.equal(b.rendered.length, renderCount);
	assert.equal(b.node("snapshot-state").textContent, "PAUSED");
	b.pause();
	assert.equal(b.requests.length, 3);
	assert.equal(b.node("refresh-toggle").attributes["aria-pressed"], "false");
	await b.reply(response(304));
	assertLive(b);
});
