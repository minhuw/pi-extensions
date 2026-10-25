// Adapted from the Subagents workflow runtime (extensions/subagents/src/workflow/worker-source.ts, MIT; see ./LICENSE).
//
// The worker is spawned with `new Worker(WORKER_SOURCE, { eval: true })`, so it is plain CommonJS in a string and never
// sees the TypeScript pipeline. Two boundaries stack here:
//
//   host thread  ←postMessage→  worker thread  ←vm context→  script
//
// The worker exists so `worker.terminate()` can stop a runaway script, even one spinning in `while (true) {}`. The vm
// context exists for determinism: `codeGeneration: { strings: false }` makes `eval`/`Function` throw, but only for
// the realm's own `Function`. A worker-realm object reaching the script would hand it the worker's `Function` (and so
// `process`), so every global, promise, array, and error the script sees is realm-native: the globals are realm
// wrappers around worker closures, and worker errors are rebuilt as realm errors before they cross.
//
// Protocol (worker → host): call { callId, method: "agent" | "integrate", payload, site }, log { message },
// phase { title }, problem { message, line?, column? } (dry runs only), complete { resultJson }, error { message,
// line?, column? }. Host → worker: response { callId, ok, valueJson?, error? }.

export const SCRIPT_FILENAME = "herder-script.js";

export const WORKER_SOURCE = String.raw`"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const port = parentPort;
const LIMITS = workerData.limits;
const COLLECT = workerData.collect === true;
const FILENAME = workerData.filename;
const AGENT_KEYS = workerData.agentKeys;
const INTEGRATE_KEYS = workerData.integrateKeys;

// Fatal errors (cap breaches, invalid options, host rejections) belong to the launch, not to one item: parallel() and
// pipeline() rethrow them instead of folding them into null.
const fatal = new WeakSet();
let RealmError = Error;
let realmErrors = {};
let realmParse = JSON.parse;
let realmObjectPrototype = Object.prototype;
let realmNewArray = function () { return []; };
let realmPush = function (array, value) { array.push(value); };

function escapeRegExp(text) { return text.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&"); }
const FRAME = new RegExp(escapeRegExp(FILENAME) + ":(\\d+):(\\d+)");

/** The first frame in the script's own source, as { line, column }. Only frame lines count: the message is the script's. */
function siteOf(stack) {
	if (typeof stack !== "string") return undefined;
	const lines = stack.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!/^\s+at /.test(lines[i])) continue;
		const match = FRAME.exec(lines[i]);
		if (match && Number(match[1]) >= 1) return { line: Number(match[1]), column: Number(match[2]) };
	}
	return undefined;
}

function callSite() { return siteOf(new Error().stack); }

// Call sites stay on the worker side: a worker-realm object reachable from the script would expose the worker's Function.
const sites = new WeakMap();

function fail(message, site) {
	const error = new RealmError(message);
	fatal.add(error);
	if (site) sites.set(error, site);
	return error;
}

/* RPC to the host */

let nextCallId = 1;
const pending = new Map();

function callHost(method, payload, site) {
	return new Promise(function (resolve, reject) {
		const callId = nextCallId++;
		pending.set(callId, { resolve: resolve, reject: reject, site: site });
		port.postMessage({ type: "call", callId: callId, method: method, payload: payload, site: site });
	});
}

port.on("message", function (message) {
	if (!message || message.type !== "response") return;
	const waiter = pending.get(message.callId);
	if (!waiter) return;
	pending.delete(message.callId);
	if (message.ok) {
		let value;
		try { value = message.valueJson === undefined ? undefined : realmParse(message.valueJson); }
		catch (error) { waiter.reject(fail("The host returned a value that is not JSON.", waiter.site)); return; }
		waiter.resolve(value);
		return;
	}
	waiter.reject(fail(typeof message.error === "string" && message.error ? message.error : "The host rejected the call.", waiter.site));
});

/* The JSON boundary */

function boundaryError(what, path) { return new Error("Cannot pass " + what + " across the script boundary (at " + path + ")."); }

function assertBoundary(value, path, seen, allowUndefined) {
	if (value === null) return;
	const kind = typeof value;
	if (kind === "string" || kind === "boolean") return;
	if (kind === "number") { if (!Number.isFinite(value)) throw boundaryError("a non-finite number", path); return; }
	if (kind === "undefined") { if (allowUndefined) return; throw boundaryError("undefined", path); }
	if (kind !== "object") throw boundaryError("a " + kind, path);
	if (seen.has(value)) throw boundaryError("a circular structure", path);
	seen.add(value);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			if (!Object.prototype.hasOwnProperty.call(value, i)) throw boundaryError("a sparse array", path + "[" + i + "]");
			assertBoundary(value[i], path + "[" + i + "]", seen, false);
		}
	} else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== null && prototype !== realmObjectPrototype && prototype !== Object.prototype) throw boundaryError("a non-plain object", path);
		const keys = Object.keys(value);
		// Object properties holding undefined are dropped by JSON, which is what a script means by leaving them out.
		for (let i = 0; i < keys.length; i++) assertBoundary(value[keys[i]], path + "." + keys[i], seen, true);
	}
	seen.delete(value);
}

/** A worker-realm plain-data copy of a script value; throws when it is not JSON data. */
function toData(value, path) {
	assertBoundary(value, path, new Set(), true);
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/* Option validation: throws at the call site, or in a dry run reports and drops the option */

function problem(message, site) {
	if (!COLLECT) throw fail(message, site);
	port.postMessage({ type: "problem", message: message, line: site && site.line, column: site && site.column });
}

function isText(value) { return typeof value === "string" && value.trim() !== ""; }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

const AGENT_CHECKS = {
	id: [isText, "a non-empty string"], label: [isText, "a non-empty string"], phase: [isText, "a non-empty string"],
	task: [isText, "a non-empty string"], role: [isText, "a non-empty string"], base: [isText, "a non-empty string"],
	effort: [isText, "a non-empty string"],
	write: [function (v) { return typeof v === "boolean"; }, "a boolean"],
	fresh: [function (v) { return typeof v === "boolean"; }, "a boolean"],
	schema: [isPlainObject, "a JSON Schema object"],
	gate: [function (v) { return isText(v) || (Array.isArray(v) && v.length > 0 && v.every(isText)); }, "a check id or a non-empty array of check ids"],
	timeoutMs: [function (v) { return typeof v === "number" && Number.isFinite(v) && v > 0; }, "a positive number"],
	stallMs: [function (v) { return typeof v === "number" && Number.isFinite(v) && v > 0; }, "a positive number"],
};
const INTEGRATE_CHECKS = {
	message: [isText, "a non-empty string"], task: [isText, "a non-empty string"],
	checks: [function (v) { return Array.isArray(v) && v.every(isText); }, "an array of check ids"],
};

function readOptions(what, opts, keys, checks, site) {
	const out = {};
	if (opts === undefined || opts === null) return out;
	if (!isPlainObject(opts)) { problem(what + " expects opts to be an object.", site); return out; }
	const names = Object.keys(opts);
	for (let i = 0; i < names.length; i++) {
		const key = names[i];
		const value = opts[key];
		if (keys.indexOf(key) === -1) { problem(what + " opts." + key + " is not a recognised option. Supported: " + keys.join(", ") + ".", site); continue; }
		if (value === undefined) continue;
		if (!checks[key][0](value)) { problem(what + " opts." + key + " must be " + checks[key][1] + ".", site); continue; }
		try { out[key] = toData(value, what + " opts." + key); } catch (error) { problem(error.message, site); }
	}
	return out;
}

/* Script globals */

let agentCount = 0;

async function agent(prompt, opts) {
	const site = callSite();
	if (!isText(prompt)) problem("agent(prompt) requires a non-empty string prompt.", site);
	const options = readOptions("agent()", opts, AGENT_KEYS, AGENT_CHECKS, site);
	agentCount++;
	if (agentCount > LIMITS.agentsPerLaunch) throw fail("agent() exceeded the limit of " + LIMITS.agentsPerLaunch + " agents per launch.", site);
	return callHost("agent", { prompt: typeof prompt === "string" ? prompt : String(prompt), opts: options }, site);
}

async function integrate(source, opts) {
	const site = callSite();
	let from = source;
	if (isPlainObject(source)) {
		if (!isText(source.key)) problem("integrate(source) expects a step result (with a key) or a commit.", site);
		try { from = toData(source, "integrate() source"); } catch (error) { problem(error.message, site); from = { key: String(source.key) }; }
	} else if (!isText(source)) {
		problem("integrate(source) expects a step result (with a key) or a commit.", site);
		from = String(source);
	}
	if (!isPlainObject(opts) || !isText(opts.message)) problem("integrate() opts.message is required and must be a non-empty string.", site);
	const options = readOptions("integrate()", opts, INTEGRATE_KEYS, INTEGRATE_CHECKS, site);
	if (options.message === undefined) options.message = "(missing message)";
	return callHost("integrate", { source: from, opts: options }, site);
}

function toList(value, what, site) {
	if (!Array.isArray(value)) throw fail(what + " expects an array.", site);
	const length = value.length >>> 0;
	if (length > LIMITS.itemsPerCall) throw fail(what + " was given " + length + " items, over the limit of " + LIMITS.itemsPerCall + ".", site);
	const out = [];
	for (let i = 0; i < length; i++) out.push(value[i]);
	return out;
}

function toRealmArray(items) {
	const array = realmNewArray();
	for (let i = 0; i < items.length; i++) realmPush(array, items[i]);
	return array;
}

function describe(value) {
	if (typeof value === "string") return value;
	// Duck-typed: an error thrown by the script belongs to the vm realm and fails instanceof against this one.
	if (value && typeof value === "object" && typeof value.message === "string") return value.message;
	try { const json = JSON.stringify(value); if (json !== undefined) return json; } catch (error) { /* fall through */ }
	return String(value);
}

function itemFailed(what, index, error) {
	port.postMessage({ type: "log", message: what + " item " + index + " failed: " + describe(error) });
	return null;
}

async function parallel(thunks) {
	const site = callSite();
	const list = toList(thunks, "parallel(thunks)", site);
	for (let i = 0; i < list.length; i++) if (typeof list[i] !== "function") throw fail("parallel(thunks) expects an array of functions; item " + i + " is not one.", site);
	const settled = await Promise.all(list.map(async function (thunk, index) {
		try { return await thunk(); }
		catch (error) { if (fatal.has(error)) throw error; return itemFailed("parallel()", index, error); }
	}));
	return toRealmArray(settled);
}

async function pipeline(items, ...stages) {
	const site = callSite();
	const list = toList(items, "pipeline(items, ...stages)", site);
	for (let i = 0; i < stages.length; i++) if (typeof stages[i] !== "function") throw fail("pipeline(items, ...stages) expects functions; stage " + i + " is not one.", site);
	const settled = await Promise.all(list.map(async function (item, index) {
		let value = item;
		for (let s = 0; s < stages.length; s++) {
			try { value = await stages[s](value, item, index); }
			catch (error) { if (fatal.has(error)) throw error; return itemFailed("pipeline()", index, error); }
		}
		return value;
	}));
	return toRealmArray(settled);
}

function phase(title) {
	if (!isText(title)) { problem("phase(title) requires a non-empty string.", callSite()); return; }
	port.postMessage({ type: "phase", title: title });
}

function log(message) { port.postMessage({ type: "log", message: describe(message) }); }

/* Unawaited calls */

// Every promise agent(), integrate(), parallel(), and pipeline() hand the script, mapped to its call site until the
// script consumes it. await, .then/.catch/.finally, Promise.all, and returning it all go through its then().
const unawaited = new Map();
function track(promise) { unawaited.set(promise, callSite()); }
function observe(promise) { unawaited.delete(promise); }

/* Run */

// Runs inside the realm before the script. Determinism matters because a relaunch replays steps by identity: a script
// that reads the clock or randomness computes different prompts the second time and reuses nothing.
// The replacement Date is a plain function, not a subclass: Object.getPrototypeOf of a subclass is the real Date.
// WeakRef and FinalizationRegistry go because garbage-collection timing is not reproducible. Memory outside the
// worker's heap limit goes too: binary buffers (typed arrays, WebAssembly.Memory; Atomics.waitAsync is also a timer),
// and Intl and Temporal, whose objects wrap native ICU data (they also read the clock: Temporal.Now, format()).
const PRELUDE = [
	"(function () {",
	"  const RealDate = globalThis.Date;",
	"  const die = function (what) { throw new Error(what + ' is unavailable in Herder scripts (it breaks resume). Pass timestamps or seeds through args.'); };",
	"  const define = function (target, key, value) { Object.defineProperty(target, key, { value: value, writable: false, configurable: false }); };",
	"  const Date = function Date(...rest) {",
	"    if (new.target === undefined) return die('Date()');",
	"    if (rest.length === 0) return die('new Date()');",
	"    return Reflect.construct(RealDate, rest, new.target);",
	"  };",
	"  define(Date, 'prototype', RealDate.prototype);",
	"  define(Date, 'UTC', RealDate.UTC);",
	"  define(Date, 'parse', RealDate.parse);",
	"  define(Date, 'now', function now() { return die('Date.now()'); });",
	"  define(RealDate.prototype, 'constructor', Date);",
	"  define(globalThis, 'Date', Date);",
	"  define(Math, 'random', function random() { return die('Math.random()'); });",
	"  for (const name of ['WeakRef', 'FinalizationRegistry', 'Intl', 'Temporal', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'WebAssembly',",
	"    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array',",
	"    'Float64Array', 'BigInt64Array', 'BigUint64Array']) delete globalThis[name];",
	"})();",
].join("\n");

function report(type, error) {
	const site = (error !== null && typeof error === "object" && sites.get(error)) || siteOf(error && error.stack);
	port.postMessage({ type: type, message: describe(error), line: site && site.line, column: site && site.column });
}

// Realm-native wrappers: the script can only reach these functions and the realm promises they return. Async globals
// return a Call, a promise whose then() reports the promise consumed; its derived promises are plain ones.
const EXPOSE = [
	"(function (track, observe) {",
	"  class Call extends Promise {",
	"    static get [Symbol.species]() { return Promise; }",
	"    then(onFulfilled, onRejected) { observe(this); return super.then(onFulfilled, onRejected); }",
	"  }",
	"  Object.freeze(Call.prototype);",
	"  Object.freeze(Call);",
	"  return function (impl, name, async) {",
	"    const holder = async",
	"      ? { [name]: function (...rest) { const call = new Call(function (resolve, reject) { impl(rest, resolve, reject); }); track(call); return call; } }",
	"      : { [name]: function (...rest) { return impl(rest); } };",
	"    Object.defineProperty(globalThis, name, { value: holder[name], writable: false, enumerable: true, configurable: false });",
	"  };",
	"})",
].join("\n");

/** A worker-realm error rebuilt in the realm as its matching error type, keeping its fatal mark and call site. */
function toRealm(error) {
	if (error === null || typeof error !== "object" || !(error instanceof Error)) return error;
	const Ctor = Object.prototype.hasOwnProperty.call(realmErrors, error.name) ? realmErrors[error.name] : RealmError;
	const copy = new Ctor(error.message);
	if (fatal.has(error)) fatal.add(copy);
	if (sites.has(error)) sites.set(copy, sites.get(error));
	return copy;
}

async function main() {
	// A null-prototype sandbox: an ordinary object would make globalThis.constructor the worker's Object.
	const context = vm.createContext(Object.create(null), { name: "herder-script", codeGeneration: { strings: false, wasm: false } });
	vm.runInContext("delete globalThis.console;\n" + PRELUDE, context);
	RealmError = vm.runInContext("Error", context);
	realmErrors = vm.runInContext("({ Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError })", context);
	const expose = vm.runInContext(EXPOSE, context)(track, observe);
	const asyncGlobals = { agent: agent, integrate: integrate, parallel: parallel, pipeline: pipeline };
	for (const name of Object.keys(asyncGlobals)) {
		const fn = asyncGlobals[name];
		expose(function (rest, resolve, reject) {
			let result;
			try { result = fn.apply(undefined, rest); } catch (error) { reject(toRealm(error)); return; }
			result.then(resolve, function (error) { reject(toRealm(error)); });
		}, name, true);
	}
	const syncGlobals = { phase: phase, log: log };
	for (const name of Object.keys(syncGlobals)) {
		const fn = syncGlobals[name];
		expose(function (rest) {
			try { fn.apply(undefined, rest); } catch (error) { throw toRealm(error); }
		}, name, false);
	}
	realmParse = vm.runInContext("JSON.parse", context);
	realmObjectPrototype = vm.runInContext("Object.prototype", context);
	realmNewArray = vm.runInContext("(function () { return []; })", context);
	realmPush = vm.runInContext("(function (array, value) { array.push(value); })", context);
	const args = workerData.argsJson === undefined ? undefined : realmParse(workerData.argsJson);
	vm.runInContext("(function (value) { Object.defineProperty(globalThis, 'args', { value: value, writable: false, enumerable: true, configurable: false }); })", context)(args);

	// The wrapper adds exactly one line above the body; lineOffset undoes it so errors point at the author's lines.
	const script = new vm.Script("(async () => {\n" + workerData.source + "\n})()", { filename: FILENAME, lineOffset: -1 });
	const value = await script.runInContext(context);
	// Decided here from the script's control flow, not from how fast the host answers: a call the script never consumed
	// fails even if it has finished. A consumed call still unanswered (a detached .then() chain, a lost race) also fails;
	// only that case depends on timing, and it would orphan a running agent.
	if (unawaited.size > 0 || pending.size > 0) {
		const site = unawaited.values().next().value;
		const message = "The script returned while calls were still pending or never awaited; await every agent(), integrate(), parallel(), and pipeline() call.";
		port.postMessage({ type: "error", message: message, line: site && site.line, column: site && site.column });
		return;
	}
	let resultJson;
	try { resultJson = value === undefined ? undefined : JSON.stringify(toData(value, "the script result")); }
	catch (error) { port.postMessage({ type: "error", message: error.message }); return; }
	port.postMessage({ type: "complete", resultJson: resultJson });
}

// An unawaited call that rejects fails the launch with its call site instead of crashing the worker.
process.on("unhandledRejection", function (error) { report("error", error); });
main().catch(function (error) { report("error", error); });
`;
