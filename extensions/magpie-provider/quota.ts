export interface MagpieConnection { origin: string; apiKey: string }

/** An observed retry opportunity, not a guarantee that the next request can run. */
export interface QuotaWait { dueAt: number; providers: string[] }

interface QuotaRequest {
	sessionId: string;
	modelIds: string[];
	directModel?: string;
	startedAt: number;
	errorMessage: string;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1024 * 1024;
const capPattern = /\bpast its (\d+(?:\.\d+)?)% cap\b/i;
function explicitCap(message: string): number | undefined {
	const match = message.match(capPattern);
	const cap = match ? Number(match[1]) : NaN;
	return cap > 0 && cap <= 100 ? cap : undefined;
}

/** Candidates still need a matching route/provider and an observed future reset. */
export function isMagpieQuotaError(message: string): boolean {
	const text = message.toLowerCase().replace(/[_-]/g, " ");
	if (/\b(?:billing|payment|insufficient quota|usage not included|unauthenticated|unauthori[sz]ed|authentication|invalid api key|invalid key|incorrect api key|permission denied)\b/.test(text)
		|| /\b(?:insufficient|not enough|out of|exhausted) (?:credits?|balance|funds)\b|\bcredit balance\b|\b(?:credits?|balance|funds) (?:exhausted|depleted|too low)\b|\b(?:spending|budget) (?:limit|exceeded|exhausted)\b/.test(text)
		|| /\bcontext (?:length|window|size|limit)\b|\b(?:input|prompt) (?:is )?too long\b|\b(?:input|prompt|token) length\b|\brequest (?:is )?too large\b/.test(text)
		|| /\b(?:input|prompt) token count\b.{0,40}\bexceeds?\b|\bexceed(?:ed|s)? (?:model )?token limit\b/.test(text)
		|| /\bmax(?:imum)? (?:output |completion )?tokens\b|\b(?:output|completion|response) (?:token |length )?(?:limit|budget)\b|\b(?:output|response) (?:is )?too long\b|\btoken limit exceeded\b|\btoo many (?:input |prompt |output )?tokens\b(?! per )/.test(text)) return false;
	return /\b429\b|\brate limit|\btoo many requests\b/.test(text) || explicitCap(text) !== undefined
		|| /\b(?:usage|quota|allowance)\b[^.\n]{0,80}\b(?:exhausted|exceeded|reached|used up|depleted|spent)\b/.test(text)
		|| /\b(?:exceeded|exhausted|reached|hit|used up|out of|ran out of)\b[^.\n]{0,60}\b(?:usage|quota|allowance)\b/.test(text)
		|| /\bno (?:remaining )?(?:quota|allowance)\b/.test(text);
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cancelled(): Error {
	return new DOMException("Magpie quota lookup cancelled.", "AbortError");
}
function checkCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw cancelled(); // Never expose the caller's arbitrary abort reason.
}
function connectionOrigin(connection: MagpieConnection): string {
	try {
		const url = new URL(connection.origin);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
			|| url.pathname !== "/" || !connection.apiKey.trim() || /[\r\n]/.test(connection.apiKey)) throw new Error();
		return url.origin;
	} catch { throw new Error("Invalid Magpie connection; check the gateway origin and API credentials."); }
}

// Race both headers and body reads, even when an underlying transport ignores abort.
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => { signal.removeEventListener("abort", abort); reject(cancelled()); };
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => {
			signal.removeEventListener("abort", abort); reject(error);
		});
	});
}

async function getJSON(connection: MagpieConnection, path: string, endpoint: "quotas" | "route", signal: AbortSignal): Promise<unknown> {
	checkCancelled(signal);
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
	let response: Response | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let failure = "request failed; check gateway availability, API credentials, and sharing permissions";
	try {
		response = await abortable(fetch(`${connection.origin}${path}`, {
			method: "GET", headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json" },
			signal: controller.signal, redirect: "error", cache: "no-store", credentials: "omit",
		}), controller.signal);
		if (!response.ok) {
			failure = `request failed (HTTP ${response.status}); check gateway availability, API credentials, and sharing permissions`;
			throw new Error();
		}
		failure = "response exceeds 1 MiB; check gateway compatibility";
		if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) throw new Error();
		failure = "returned an invalid response; check gateway compatibility";
		if (!response.body) throw new Error();
		reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const { value, done } = await abortable(reader.read(), controller.signal);
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) { failure = "response exceeds 1 MiB; check gateway compatibility"; throw new Error(); }
			chunks.push(value);
		}
		checkCancelled(signal);
		return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
	} catch {
		checkCancelled(signal);
		if (controller.signal.aborted) throw new Error(`Magpie ${endpoint} request timed out after 15 seconds.`);
		// Neither transport errors nor response bodies are safe to put in a footer.
		throw new Error(`Magpie ${endpoint} ${failure}.`);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		controller.abort();
		// Cancellation cleanup must not wait for the remote stream to close.
		if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
		else if (response?.body) void response.body.cancel().catch(() => {});
	}
}

function timestamp(value: unknown): number | undefined {
	// Magpie emits RFC3339 times, including nanoseconds. Reject date-only/local
	// times and Date.parse's coercion of numbers and impossible calendar dates.
	if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return undefined;
	const at = Date.parse(value);
	if (!Number.isFinite(at) || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) return undefined;
	return at;
}
function failedStatus(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599;
}

function triedModels(value: unknown, request: QuotaRequest): string[] | undefined {
	if (!object(value) || value.session !== request.sessionId || !object(value.route)) return undefined;
	const route = value.route;
	const time = timestamp(route.time);
	if (route.done !== true || !failedStatus(route.status) || (route.kind !== undefined && route.kind !== "")
		|| typeof route.asked !== "string" || !request.modelIds.includes(route.asked)
		|| !Number.isFinite(request.startedAt) || time === undefined || time < request.startedAt - 1000
		|| !Array.isArray(route.tries) || !route.tries.length) return undefined;
	// A usable route is authoritative. In particular, explicit credit/auth/other
	// failures cannot become quota failures through a direct-model fallback.
	return route.tries.flatMap(attempt => {
		if (!object(attempt) || attempt.done !== true || !failedStatus(attempt.status) || typeof attempt.model !== "string") return [];
		const quota = attempt.fail === "quota" || attempt.fail === "rate";
		const unnamed429 = (attempt.fail === undefined || attempt.fail === "") && attempt.status === 429;
		return quota || unnamed429 ? [attempt.model] : [];
	});
}

function providerId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value === value.trim()
		&& !/[\u0000-\u001f\u007f]/.test(value) && value.split("/").every(part => part.length > 0);
}
function providerFor(model: string | undefined, providers: string[]): string | undefined {
	if (!model) return undefined;
	// Include even unusable/balance cards in prefix selection: a parent's card
	// must not stand in for a more specific remote provider's missing reading.
	return providers.filter(provider => model.startsWith(`${provider}/`) && model.length > provider.length + 1)
		.sort((a, b) => b.length - a.length)[0];
}
function exhausted(window: Record<string, unknown>, threshold: number): boolean {
	if ((window.unlimited !== undefined && window.unlimited !== false) || (window.text !== undefined && window.text !== false)
		|| window.balance !== undefined) return false;
	for (const field of ["used", "remaining"] as const) {
		if (window[field] !== undefined && (typeof window[field] !== "number" || !Number.isFinite(window[field]))) return false;
	}
	if (typeof window.used === "number" && window.used < 0) return false;
	return (typeof window.used === "number" && window.used >= threshold)
		|| (typeof window.remaining === "number" && window.remaining <= 100 - threshold);
}

/**
 * Fetch fresh public observations only after a quota-like failure. The public
 * APIs do not bind windows to models/families or route tries to accounts: the
 * earliest matching reset is worth retrying, but other windows/accounts may
 * still block it. No provider-name inference, guessed reset, or polling delay.
 */
export async function queryMagpieQuotaWait(connection: MagpieConnection, request: QuotaRequest, signal?: AbortSignal): Promise<QuotaWait | undefined> {
	checkCancelled(signal);
	if (!isMagpieQuotaError(request.errorMessage)) return undefined;
	const scopedConnection = { origin: connectionOrigin(connection), apiKey: connection.apiKey };
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		// Capture the optional route failure while quotas are fetched in parallel.
		const [quotas, route] = await Promise.all([
			getJSON(scopedConnection, "/v1/magpie/quotas", "quotas", controller.signal),
			getJSON(scopedConnection, `/v1/magpie/route?session=${encodeURIComponent(request.sessionId)}`, "route", controller.signal)
				.then(value => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error })),
		]);
		checkCancelled(signal);
		if (!object(quotas) || quotas.object !== "list" || !Array.isArray(quotas.data)) {
			throw new Error("Magpie quotas returned an invalid list; check gateway compatibility.");
		}
		const cards = quotas.data.filter(object);
		const providers = [...new Set(cards.flatMap(card => providerId(card.provider) ? [card.provider] : []))];
		const directProvider = providerFor(request.directModel, providers);
		if (route.error && !directProvider) throw route.error;
		const models = triedModels(route.value, request);
		const matched = new Set(models === undefined ? directProvider ? [directProvider] : []
			: models.flatMap(model => { const provider = providerFor(model, providers); return provider ? [provider] : []; }));
		const threshold = explicitCap(request.errorMessage) ?? 100;
		const now = Date.now();
		let dueAt = Infinity;
		const exhaustedProviders = new Set<string>();
		for (const card of cards) {
			if (!providerId(card.provider) || !matched.has(card.provider) || !["subscription", "plan"].includes(card.kind as string)
				|| !Array.isArray(card.windows)) continue;
			for (const window of card.windows) {
				if (!object(window) || !exhausted(window, threshold)) continue;
				const reset = timestamp(window.resetsAt);
				if (reset === undefined || reset <= now) continue;
				dueAt = Math.min(dueAt, reset);
				exhaustedProviders.add(card.provider);
			}
		}
		return Number.isFinite(dueAt) ? { dueAt, providers: [...exhaustedProviders] } : undefined;
	} finally {
		signal?.removeEventListener("abort", abort);
		controller.abort();
	}
}
