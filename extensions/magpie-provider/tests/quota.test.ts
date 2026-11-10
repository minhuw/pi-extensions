import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMagpieQuotaError, queryMagpieQuotaWait } from "../quota.ts";

const NOW = Date.parse("2030-05-04T12:00:00Z");
const connection = { origin: "https://gateway.example", apiKey: "secret-gateway-key" };
const request = {
	sessionId: "session-1", modelIds: ["gpt-6-astra", "auto/gpt-6-astra"], startedAt: NOW - 5000,
	errorMessage: "You've hit your usage limit",
};
const iso = (at: number) => new Date(at).toISOString();
function window(after = 60_000, fields: Record<string, unknown> = {}) {
	return { used: 100, remaining: 0, resetsAt: iso(NOW + after), ...fields };
}
function card(provider = "remote/codex", windows: unknown = [window()], fields: Record<string, unknown> = {}) {
	return { provider, kind: "subscription", windows, ...fields };
}
function attempt(model = "remote/codex/gpt-6-astra", fields: Record<string, unknown> = {}) {
	return { model, done: true, status: 429, fail: "quota", ...fields };
}
function route(fields: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
	return { session: request.sessionId, route: {
		time: iso(request.startedAt), asked: "auto/gpt-6-astra", done: true, status: 429,
		tries: [attempt()], ...fields,
	}, ...envelope };
}
const list = (data: unknown = [card()]) => ({ object: "list", data });
function http(quotas: unknown = list(), routing: unknown = route()) {
	const mock = vi.fn(async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/magpie/quotas") return Response.json(quotas);
		if (url.pathname === "/v1/magpie/route") return Response.json(routing);
		throw new Error("Unexpected request");
	});
	vi.stubGlobal("fetch", mock);
	return mock;
}
async function failure(promise: Promise<unknown>): Promise<Error> {
	try { await promise; } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
	throw new Error("Expected rejection");
}
function expectSafe(error: Error) {
	expect(error.message).not.toMatch(/secret-gateway-key|gateway\.example|owner@example\.com|account-identity|secret-session/);
	expect(error.cause).toBeUndefined();
}
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("quota error candidates", () => {
	it.each([
		"You've hit your usage limit", "usage_limit_reached", "Your weekly usage limit has been reached",
		"Usage has exceeded the limit. Your usage limit will reset in 5 hours.", "Go usage limit exceeded",
		"Quota exhausted", "You exceeded your current quota", "Your plan's allowance is used up",
		"All accounts are out of their allowance", "No remaining allowance", "Usage cap reached",
		"Codex is at 91% of a usage window, past its 90% cap", "HTTP 429", "Too many requests",
		"rate_limit_error", "rate-limit exceeded", "Rate limit reached on tokens per minute (TPM)",
		"Too many tokens per minute: rate limit reached",
	])("recognizes %s", message => { expect(isMagpieQuotaError(message)).toBe(true); });

	it.each([
		"", "quota", "Usage data unavailable", "Something went wrong", "HTTP 503 overloaded",
		"429 insufficient_quota: You exceeded your current quota", "429 quota exceeded; check billing details",
		"429 payment required", "Usage limit: insufficient credits", "429 credit balance too low",
		"429 out of funds", "429 budget exceeded", "429 invalid API key", "429 incorrect_api_key",
		"429 unauthorized", "429 unauthenticated", "429 authentication_error", "429 permission denied",
		"429 usage_not_included: upgrade to Plus", "429 context_length_exceeded", "429 context window is full",
		"429 maximum context length", "429 prompt is too long", "429 input is too long",
		"429 input token count exceeds the maximum", "429 exceeded model token limit", "429 token limit exceeded",
		"429 too many input tokens", "429 max_tokens must be positive", "429 max_output_tokens exceeded",
		"429 output token limit reached", "429 output token budget exhausted", "429 request too large",
	])("excludes %s", message => { expect(isMagpieQuotaError(message)).toBe(false); });

	it("does not make requests for non-quota errors", async () => {
		const mock = http();
		await expect(queryMagpieQuotaWait(connection, { ...request, errorMessage: "429 insufficient_quota" })).resolves.toBeUndefined();
		expect(mock).not.toHaveBeenCalled();
	});
});

describe("correlation and observed resets", () => {
	it("does no work on import, then uses fresh authenticated public GETs with an encoded session", async () => {
		const mock = http();
		vi.resetModules();
		await import("../quota.ts");
		expect(mock).not.toHaveBeenCalled();
		const sessionId = "session /?#&=中文";
		mock.mockImplementation(async input => String(input).includes("/quotas") ? Response.json(list()) : Response.json(route({}, { session: sessionId })));
		const wait = { dueAt: NOW + 60_000, providers: ["remote/codex"] };
		await expect(queryMagpieQuotaWait(connection, { ...request, sessionId })).resolves.toEqual(wait);
		await expect(queryMagpieQuotaWait(connection, { ...request, sessionId })).resolves.toEqual(wait);
		expect(mock).toHaveBeenCalledTimes(4);
		for (const path of ["/v1/magpie/quotas", `/v1/magpie/route?session=${encodeURIComponent(sessionId)}`]) {
			expect(mock).toHaveBeenCalledWith(`${connection.origin}${path}`, {
				method: "GET", headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json" },
				redirect: "error", credentials: "omit", cache: "no-store", signal: expect.any(AbortSignal),
			});
		}
	});

	it("matches nested provider IDs exactly across mixed accounts, without using unrelated earlier resets", async () => {
		http(list([
			card("codex", [window(1000)]), card("remote", [window(2000)]), card("remote/codex", [window(3000)]),
			card("remote/codex/team", [window(20_000), window(90_000)], { user: "owner@example.com", account: "account-identity" }),
			card("remote/codex/team", [window(10_000)], { user: "other@example.com", name: "Account Two" }),
			card("remote/codex/team", [window(500, { used: 12, remaining: 88 })]),
			card("remote/codex/team-other", [window(100)]), card("unrelated", [window(50)]),
		]), route({ tries: [attempt("remote/codex/team/gpt-6-astra")] }));
		await expect(queryMagpieQuotaWait(connection, request)).resolves.toEqual({ dueAt: NOW + 10_000, providers: ["remote/codex/team"] });
	});

	it("takes the earliest observed exhausted window on a provider, even when another window resets later", async () => {
		http(list([card("remote/codex", [window(24 * 60 * 60_000), window(60_000), window(500, { used: 90, remaining: 10 })])]));
		await expect(queryMagpieQuotaWait(connection, request)).resolves.toEqual({ dueAt: NOW + 60_000, providers: ["remote/codex"] });
	});

	it("uses all quota/rate tries, deduplicates providers, and excludes explicit non-quota failures even with status 429", async () => {
		const excluded = ["credit", "auth", "other", "overflow", "canceled", "unknown"];
		http(list([
			...excluded.map(provider => card(provider, [window(100)])),
			card("remote/codex", [window(90_000)]), card("claude", [window(30_000)], { kind: "plan" }),
			card("fallback", [window(60_000)]), card("still-running", [window(10)]), card("success", [window(10)]),
		]), route({ tries: [
			...excluded.map(fail => attempt(`${fail}/model`, { fail })), attempt(), attempt(),
			attempt("claude/opus", { fail: "rate", status: 503 }), attempt("fallback/model", { fail: undefined }),
			attempt("still-running/model", { done: false }), attempt("success/model", { status: 200 }),
		] }));
		await expect(queryMagpieQuotaWait(connection, request)).resolves.toEqual({ dueAt: NOW + 30_000, providers: ["remote/codex", "claude", "fallback"] });
	});

	it.each(["credit", "auth", "other"])("does not override a fresh explicit %s failure with the direct-model fallback", async fail => {
		http(list(), route({ tries: [attempt(undefined, { fail })] }));
		await expect(queryMagpieQuotaWait(connection, { ...request, directModel: "remote/codex/gpt-6-astra" })).resolves.toBeUndefined();
	});

	it.each([
		{ time: iso(request.startedAt - 1001) }, { time: "bad" }, { time: NOW }, { done: false }, { done: undefined },
		{ status: 200 }, { status: "429" }, { status: undefined }, { asked: "group/other" }, { asked: "codex/gpt-6-astra" },
		{ asked: undefined }, { kind: "title" }, { kind: "subagent" }, { kind: null }, { tries: [] }, { tries: undefined },
		{ tries: [attempt(undefined, { done: undefined })] }, { tries: [attempt(undefined, { model: undefined })] },
	])("fails closed for unusable route metadata %j", async fields => {
		http(list(), route(fields));
		await expect(queryMagpieQuotaWait(connection, request)).resolves.toBeUndefined();
	});

	it("requires the exact session, accepts the one-second freshness boundary, and matches any explicit requested ID", async () => {
		const mock = http(list(), route({}, { session: "other-session" }));
		await expect(queryMagpieQuotaWait(connection, request)).resolves.toBeUndefined();
		mock.mockImplementation(async input => String(input).includes("/quotas") ? Response.json(list()) :
			Response.json(route({ time: iso(request.startedAt - 1000), asked: request.modelIds[0], kind: "" })));
		await expect(queryMagpieQuotaWait(connection, request)).resolves.toEqual({ dueAt: NOW + 60_000, providers: ["remote/codex"] });
	});

	it("does not infer group members, bare aliases, first-owner identity, or a concrete fallback from modelIds", async () => {
		http(list([card(), card("codex"), card("claude")]), { session: request.sessionId, route: null });
		for (const modelIds of [["group/gpt-6-astra"], ["gpt-6-astra"], ["codex/gpt-6-astra"]]) {
			await expect(queryMagpieQuotaWait(connection, { ...request, modelIds })).resolves.toBeUndefined();
		}
		await expect(queryMagpieQuotaWait(connection, { ...request, directModel: "gpt-6-astra" })).resolves.toBeUndefined();
	});

	it("uses only an explicitly supplied direct model when a route is absent or stale", async () => {
		for (const routing of [{ session: request.sessionId, route: null }, route({ time: iso(request.startedAt - 2000) }), route({ tries: [] })]) {
			http(list([card("remote", [window(100)]), card(), card("codex", [window(200)])]), routing);
			await expect(queryMagpieQuotaWait(connection, { ...request, directModel: "remote/codex/gpt-6-astra" }))
				.resolves.toEqual({ dueAt: NOW + 60_000, providers: ["remote/codex"] });
		}
	});

	it("does not borrow a shorter provider prefix when the longest provider only has balance or malformed cards", async () => {
		for (const fields of [{ kind: "balance" }, { kind: undefined }, { windows: undefined }]) {
			http(list([card("remote", [window(100)]), card("remote/codex", [window()], fields)]));
			await expect(queryMagpieQuotaWait(connection, request)).resolves.toBeUndefined();
		}
	});

	it("does not use a route's unproven final model or unrelated cards when its tries cannot match", async () => {
		http(list(), route({ model: "remote/codex/gpt-6-astra", tries: [attempt("unlisted/gpt-6-astra")] }));
		await expect(queryMagpieQuotaWait(connection, { ...request, directModel: "remote/codex/gpt-6-astra" })).resolves.toBeUndefined();
	});

	it.each([
		{ unlimited: true }, { unlimited: "false" }, { unlimited: null }, { text: true }, { text: "false" },
		{ balance: 0 }, { balance: 100 }, { balance: null }, { used: "100" }, { remaining: "0" },
		{ used: null }, { remaining: null }, { used: -1 }, { used: undefined, remaining: undefined },
		{ used: 99.9, remaining: 0.1 }, { resetsAt: null }, { resetsAt: "bad" }, { resetsAt: NOW + 60_000 },
		{ resetsAt: "2030-05-05" }, { resetsAt: "2030-05-05T12:00:00" }, { resetsAt: "2031-02-30T12:00:00Z" },
		{ resetsAt: "2030-05-05T24:00:00Z" }, { resetsAt: iso(NOW - 1) }, { resetsAt: iso(NOW) },
	])("ignores unusable or non-exhausted windows %j", async fields => {
		http(list([card("remote/codex", [window(60_000, fields)])]));
		await expect(queryMagpieQuotaWait(connection, request)).resolves.toBeUndefined();
	});

	it("accepts either numeric exhaustion field and RFC3339 timezone/nanosecond timestamps", async () => {
		for (const fields of [
			{ used: 100, remaining: undefined, resetsAt: "2030-05-04T14:01:00+02:00" },
			{ used: undefined, remaining: -1, resetsAt: "2030-05-04T12:01:00.000000000Z" },
		]) {
			http(list([card("remote/codex", [window(60_000, fields)])]));
			await expect(queryMagpieQuotaWait(connection, request)).resolves.toEqual({ dueAt: NOW + 60_000, providers: ["remote/codex"] });
		}
	});

	it.each([80, 90, 95.5, 100])("uses the %s%% threshold only for Magpie's explicit cap wording", async cap => {
		http(list([card("remote/codex", [window(100, { used: cap - 0.1, remaining: 100 - cap + 0.1 }),
			window(30_000, { used: cap, remaining: 100 - cap })])]));
		if (cap < 100) {
			for (const errorMessage of [request.errorMessage, `429 usage at ${cap}%`, "429 past its 0% cap", "429 past its 101% cap"]) {
				await expect(queryMagpieQuotaWait(connection, { ...request, errorMessage })).resolves.toBeUndefined();
			}
		}
		await expect(queryMagpieQuotaWait(connection, { ...request, errorMessage: `Codex is past its ${cap}% cap` }))
			.resolves.toEqual({ dueAt: NOW + 30_000, providers: ["remote/codex"] });
	});

	it("cannot arm another timer from a reset that has already passed", async () => {
		const mock = http();
		await expect(queryMagpieQuotaWait(connection, request)).resolves.toMatchObject({ dueAt: NOW + 60_000 });
		vi.mocked(Date.now).mockReturnValue(NOW + 60_001);
		await expect(queryMagpieQuotaWait(connection, request)).resolves.toBeUndefined();
		expect(mock).toHaveBeenCalledTimes(4);
	});

	it.each([null, [], {}, { object: "other", data: [] }, { object: "list", data: {} }])("rejects invalid quota envelopes without exposing fields: %j", async quotas => {
		http(quotas);
		const error = await failure(queryMagpieQuotaWait(connection, request));
		expect(error.message).toMatch(/Magpie quotas returned an invalid list/); expectSafe(error);
	});

	it("skips malformed cards, paid balances, missing providers/kinds, and healthy readings", async () => {
		http(list([null, [], {}, card(undefined, null), card("", [window()]), card("remote/codex", [window()], { kind: "balance" }),
			card("remote/codex", [window()], { kind: undefined }), card("remote/codex", [window()], { kind: "unknown" }),
			card("remote/codex", [window(10, { used: 0, remaining: 100 })]), card("remote/codex", [null, {}, []]),
		]));
		await expect(queryMagpieQuotaWait(connection, request)).resolves.toBeUndefined();
	});
});

describe("bounded and sanitized public requests", () => {
	it.each([401, 403, 404, 500])("reports actionable quota HTTP %s without reading its error body", async status => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const response = new Response(body, { status, statusText: "owner@example.com secret-gateway-key" });
		const read = vi.spyOn(body, "getReader");
		const mock = http();
		mock.mockImplementation(async input => String(input).includes("/quotas") ? response : Response.json(route()));
		const error = await failure(queryMagpieQuotaWait(connection, { ...request, directModel: "remote/codex/gpt-6-astra" }));
		expect(error.message).toMatch(`HTTP ${status}`); expect(error.message).toMatch(/credentials.*sharing/); expectSafe(error);
		expect(read).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
	});

	it.each(["network", "invalid-json", "body-error", "redirect"])("sanitizes %s failures", async mode => {
		const mock = http();
		mock.mockImplementation(async input => {
			if (!String(input).includes("/quotas")) return Response.json(route());
			const secret = "https://gateway.example secret-gateway-key owner@example.com account-identity";
			if (mode === "network") throw new Error(secret);
			if (mode === "invalid-json") return new Response(secret);
			if (mode === "redirect") return new Response(secret, { status: 302, headers: { Location: "https://evil.example" } });
			return new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } }));
		});
		const error = await failure(queryMagpieQuotaWait(connection, request));
		expectSafe(error); expect(error.message).toMatch(/Magpie quotas/);
		expect(mock).toHaveBeenCalledTimes(2);
	});

	it("refuses an actual HTTP redirect without contacting its destination or forwarding credentials", async () => {
		const received: (string | undefined)[] = [];
		let destinationRequests = 0;
		const destination = createServer((_req, res) => { destinationRequests++; res.end("{}"); });
		const gateway = createServer((req, res) => {
			received.push(req.headers.authorization);
			const address = destination.address();
			if (!address || typeof address === "string") throw new Error("Missing fixture port");
			res.writeHead(302, { Location: `http://127.0.0.1:${address.port}/secret-gateway-key` });
			res.end("owner@example.com account-identity");
		});
		try {
			await new Promise<void>(resolve => destination.listen(0, "127.0.0.1", resolve));
			await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
			const address = gateway.address();
			if (!address || typeof address === "string") throw new Error("Missing fixture port");
			const error = await failure(queryMagpieQuotaWait({ ...connection, origin: `http://127.0.0.1:${address.port}` }, request));
			expectSafe(error); expect(error.message).not.toMatch(/127\.0\.0\.1/);
			expect(error.message).toMatch(/Magpie quotas request failed/);
			expect(received.length).toBeGreaterThan(0);
			expect(received.every(authorization => authorization === `Bearer ${connection.apiKey}`)).toBe(true);
			expect(destinationRequests).toBe(0);
		} finally {
			await Promise.all([gateway, destination].map(server => new Promise<void>((resolve, reject) => {
				server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
			})));
		}
	});

	it("treats a failed route endpoint as optional only when an explicit direct model scopes an actual provider", async () => {
		const mock = http();
		mock.mockImplementation(async input => String(input).includes("/quotas") ? Response.json(list()) :
			new Response("owner@example.com secret-gateway-key", { status: 403 }));
		for (const directModel of [undefined, "gpt-6-astra", "unknown/gpt-6-astra"]) {
			const error = await failure(queryMagpieQuotaWait(connection, { ...request, directModel }));
			expect(error.message).toMatch(/Magpie route.*HTTP 403/); expectSafe(error);
		}
		await expect(queryMagpieQuotaWait(connection, { ...request, directModel: "remote/codex/gpt-6-astra" }))
			.resolves.toEqual({ dueAt: NOW + 60_000, providers: ["remote/codex"] });
	});

	it.each(["headers", "stream", "multibyte"])("enforces the 1 MiB cap on %s and cancels the body", async mode => {
		const max = 1024 * 1024;
		const cancel = vi.fn();
		const bytes = mode === "multibyte" ? new TextEncoder().encode("ü".repeat(max / 2 + 1)) : new Uint8Array(max + 1);
		const body = new ReadableStream<Uint8Array>({ start(controller) {
			if (mode !== "headers") { controller.enqueue(bytes.subarray(0, 512)); controller.enqueue(bytes.subarray(512)); }
		}, cancel });
		const mock = http();
		mock.mockImplementation(async input => String(input).includes("/quotas") ? new Response(body,
			mode === "headers" ? { headers: { "content-length": String(max + 1) } } : {}) : Response.json(route()));
		const error = await failure(queryMagpieQuotaWait(connection, request));
		expect(error.message).toMatch(/exceeds 1 MiB/); expectSafe(error); expect(cancel).toHaveBeenCalledOnce();
	});

	it("accepts a valid body exactly at the size limit", async () => {
		const json = JSON.stringify(list());
		const mock = http();
		mock.mockImplementation(async input => String(input).includes("/quotas") ?
			new Response(json.padEnd(1024 * 1024), { headers: { "content-length": String(1024 * 1024) } }) : Response.json(route()));
		await expect(queryMagpieQuotaWait(connection, request)).resolves.toMatchObject({ dueAt: NOW + 60_000 });
	});

	it.each(["quotas", "route"])("bounds %s headers at 15 seconds even if fetch ignores abort", async endpoint => {
		vi.useFakeTimers();
		const signals: AbortSignal[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
			signals.push(init.signal as AbortSignal);
			return input.includes(`/magpie/${endpoint}`) ? new Promise<Response>(() => {}) : Response.json(endpoint === "route" ? list() : route());
		}));
		const pending = failure(queryMagpieQuotaWait(connection, request));
		await vi.advanceTimersByTimeAsync(14_999);
		expect(signals.some(signal => !signal.aborted)).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		const error = await pending;
		expect(error.message).toBe(`Magpie ${endpoint} request timed out after 15 seconds.`); expectSafe(error);
		expect(signals.every(signal => signal.aborted)).toBe(true); expect(vi.getTimerCount()).toBe(0);
	});

	it("includes body reading in the same 15-second deadline and does not wait for cancellation cleanup", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		vi.stubGlobal("fetch", vi.fn(async (input: string) => {
			if (!input.includes("/quotas")) return Response.json(route());
			await new Promise(resolve => setTimeout(resolve, 10_000));
			return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel }));
		}));
		const pending = failure(queryMagpieQuotaWait(connection, request));
		await vi.advanceTimersByTimeAsync(15_000);
		expect((await pending).message).toBe("Magpie quotas request timed out after 15 seconds.");
		expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
	});

	it("allows a timed-out route to fall back to the explicit direct model", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", vi.fn(async (input: string) => input.includes("/quotas") ? Response.json(list()) : new Promise<Response>(() => {})));
		const pending = queryMagpieQuotaWait(connection, { ...request, directModel: "remote/codex/gpt-6-astra" });
		await vi.advanceTimersByTimeAsync(15_000);
		await expect(pending).resolves.toEqual({ dueAt: NOW + 60_000, providers: ["remote/codex"] });
	});

	it("rejects a pre-cancelled query without sending credentials or exposing its reason", async () => {
		const mock = http(); const controller = new AbortController();
		controller.abort(new Error("secret-gateway-key https://gateway.example owner@example.com"));
		const error = await failure(queryMagpieQuotaWait(connection, request, controller.signal));
		expect(error.name).toBe("AbortError"); expect(error.message).toMatch(/cancelled/); expectSafe(error);
		expect(mock).not.toHaveBeenCalled();
	});

	it.each(["headers", "body"])("honors cancellation during %s, aborting both requests without a direct fallback", async mode => {
		const controller = new AbortController(); const signals: AbortSignal[] = []; const cancel = vi.fn();
		let bodyStarted!: () => void;
		const started = new Promise<void>(resolve => { bodyStarted = resolve; });
		vi.stubGlobal("fetch", vi.fn(async (_input: string, init: RequestInit) => {
			signals.push(init.signal as AbortSignal);
			if (mode === "headers") { bodyStarted(); return new Promise<Response>(() => {}); }
			return new Response(new ReadableStream<Uint8Array>({ pull() { bodyStarted(); }, cancel }));
		}));
		const pending = failure(queryMagpieQuotaWait(connection, { ...request, directModel: "remote/codex/gpt-6-astra" }, controller.signal));
		await started;
		controller.abort(new Error("secret-gateway-key https://gateway.example owner@example.com"));
		const error = await pending;
		expect(error.name).toBe("AbortError"); expectSafe(error);
		expect(signals).toHaveLength(2); expect(signals.every(signal => signal.aborted)).toBe(true);
		if (mode === "body") expect(cancel).toHaveBeenCalledTimes(2);
	});

	it.each([
		"https://owner@example.com", "https://gateway.example/?secret=key", "https://gateway.example/#key",
		"https://gateway.example/v1", "file:///secret-gateway-key", "https://gateway.example@evil.example",
	])("rejects an unsafe connection before any request: %s", async origin => {
		const mock = http();
		const error = await failure(queryMagpieQuotaWait({ ...connection, origin }, request));
		expectSafe(error); expect(error.message).toMatch(/Invalid Magpie connection/); expect(mock).not.toHaveBeenCalled();
	});
});
