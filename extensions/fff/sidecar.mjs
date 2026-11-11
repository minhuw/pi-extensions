import fs from "node:fs";
import path from "node:path";

const MAX_AUX = 16;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

process.on("disconnect", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const entries = new Map();
const pending = new Map();

let dbDisabled = false;
let lastDbFallbackError = undefined;
let lastDbPathsKey = null;
let lastTick = 0;
let fileFinderPromise = null;

function makeConfigKey(params) {
	return JSON.stringify({
		enableHomeDirScanning: Boolean(params.enableHomeDirScanning),
		enableFsRootScanning: Boolean(params.enableFsRootScanning),
		followSymlinks: Boolean(params.followSymlinks),
		frecencyDbPath: params.frecencyDbPath ?? null,
		historyDbPath: params.historyDbPath ?? null,
	});
}

function makeDbPathsKey(params) {
	return JSON.stringify({
		frecencyDbPath: params.frecencyDbPath ?? null,
		historyDbPath: params.historyDbPath ?? null,
	});
}

function buildEnsureResult(root, created) {
	return dbDisabled && lastDbFallbackError !== undefined
		? { root, created, dbFallbackError: lastDbFallbackError }
		: { root, created };
}

function nextTick() {
	const now = Date.now();
	lastTick = now > lastTick ? now : lastTick + 1;
	return lastTick;
}

async function loadFileFinder() {
	if (!fileFinderPromise) {
		fileFinderPromise = (async () => {
			const { FileFinder } = await import("@ff-labs/fff-node");
			return FileFinder;
		})();
		fileFinderPromise.catch(() => {
			fileFinderPromise = null;
		});
	}
	return fileFinderPromise;
}

function canonicalizeRoot(p) {
	const resolved = path.resolve(p);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function coversRoot(entryRoot, target) {
	return (
		entryRoot === target ||
		target.startsWith(entryRoot.endsWith(path.sep) ? entryRoot : entryRoot + path.sep)
	);
}

function evictAuxIfNeeded() {
	while (true) {
		let unpinnedCount = 0;
		let oldest = null;
		for (const entry of entries.values()) {
			if (!entry.pinned) {
				unpinnedCount++;
				if (!oldest || entry.lastUsed < oldest.lastUsed) {
					oldest = entry;
				}
			}
		}
		if (unpinnedCount <= MAX_AUX || !oldest) {
			break;
		}
		entries.delete(oldest.root);
	}
}

async function ensureEntry(params) {
	if (!params || typeof params.basePath !== "string" || params.basePath.length === 0) {
		throw new Error("ensure requires a non-empty basePath");
	}

	const target = canonicalizeRoot(params.basePath);
	const isWorkspace = params.kind === "workspace";
	const exact = isWorkspace || params.exact === true;
	const configKey = makeConfigKey(params);
	const dbPathsKey = makeDbPathsKey(params);
	const hasDbPaths = Boolean(params.frecencyDbPath || params.historyDbPath);

	if (exact) {
		const inflight = pending.get(target);
		if (inflight) {
			if (inflight.configKey === configKey) {
				if (isWorkspace) {
					inflight.pinned = true;
				}
				const entry = await inflight.promise;
				if (isWorkspace) {
					entry.pinned = true;
				}
				entry.lastUsed = nextTick();
				return buildEnsureResult(entry.root, false);
			}
			await inflight.promise.catch(() => {});
		}

		const existing = entries.get(target);
		if (existing && !existing.finder.isDestroyed) {
			if (existing.configKey === configKey) {
				if (isWorkspace) {
					existing.pinned = true;
				}
				existing.lastUsed = nextTick();
				return buildEnsureResult(existing.root, false);
			}
			if (existing.dbPathsKey !== dbPathsKey) {
				dbDisabled = false;
				lastDbFallbackError = undefined;
				lastDbPathsKey = null;
			}
		}
	} else {
		let bestEntry = null;
		for (const entry of entries.values()) {
			if (entry.finder.isDestroyed) continue;
			if (coversRoot(entry.root, target)) {
				if (!bestEntry || entry.root.length > bestEntry.root.length) {
					bestEntry = entry;
				}
			}
		}

		let bestPendingRoot = null;
		let bestPending = null;
		for (const [pendingRoot, record] of pending.entries()) {
			if (coversRoot(pendingRoot, target)) {
				if (
					(!bestEntry || pendingRoot.length > bestEntry.root.length) &&
					(!bestPendingRoot || pendingRoot.length > bestPendingRoot.length)
				) {
					bestPendingRoot = pendingRoot;
					bestPending = record;
				}
			}
		}

		if (bestPending) {
			const entry = await bestPending.promise;
			entry.lastUsed = nextTick();
			return buildEnsureResult(entry.root, false);
		}

		if (bestEntry) {
			bestEntry.lastUsed = nextTick();
			return buildEnsureResult(bestEntry.root, false);
		}
	}

	if (dbDisabled && hasDbPaths && lastDbPathsKey !== null && lastDbPathsKey !== dbPathsKey) {
		dbDisabled = false;
		lastDbFallbackError = undefined;
		lastDbPathsKey = null;
	}

	const priorEntry = entries.get(target);
	const pendingRecord = {
		promise: null,
		pinned: isWorkspace || Boolean(priorEntry?.pinned),
		configKey,
	};
	const createTask = (async () => {
		const FileFinder = await loadFileFinder();
		const baseOptions = {
			basePath: target,
			aiMode: true,
			enableHomeDirScanning: params.enableHomeDirScanning,
			enableFsRootScanning: params.enableFsRootScanning,
			followSymlinks: params.followSymlinks,
		};

		let usedDbPaths = false;
		let res;

		if (hasDbPaths && !dbDisabled) {
			res = FileFinder.create({
				...baseOptions,
				frecencyDbPath: params.frecencyDbPath,
				historyDbPath: params.historyDbPath,
			});
			if (res.ok) {
				usedDbPaths = true;
			} else {
				const firstError = res.error;
				res = FileFinder.create(baseOptions);
				if (res.ok) {
					dbDisabled = true;
					lastDbFallbackError = firstError;
					lastDbPathsKey = dbPathsKey;
				}
			}
		} else {
			res = FileFinder.create(baseOptions);
		}

		if (!res.ok) {
			throw new Error(res.error);
		}

		const finder = res.value;
		await finder.waitForScan(params.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);

		const entry = {
			root: target,
			finder,
			pinned: pendingRecord.pinned,
			lastUsed: nextTick(),
			configKey,
			dbPathsKey,
			options: usedDbPaths
				? {
						...baseOptions,
						frecencyDbPath: params.frecencyDbPath,
						historyDbPath: params.historyDbPath,
					}
				: baseOptions,
		};

		entries.set(target, entry);
		evictAuxIfNeeded();
		return entry;
	})();

	createTask.catch(() => {});
	pendingRecord.promise = createTask;
	pending.set(target, pendingRecord);

	try {
		const entry = await createTask;
		return buildEnsureResult(entry.root, true);
	} finally {
		if (pending.get(target) === pendingRecord) {
			pending.delete(target);
		}
	}
}

function requireEntry(root) {
	if (typeof root !== "string" || root.length === 0) {
		throw new Error("Missing root parameter");
	}
	const entry = entries.get(root) ?? entries.get(canonicalizeRoot(root));
	if (!entry || entry.finder.isDestroyed) {
		throw new Error(`FFF root not initialized: ${root}`);
	}
	entry.lastUsed = nextTick();
	return entry;
}

async function handleMethod(method, params = {}) {
	switch (method) {
		case "ensure":
			return ensureEntry(params);
		case "scanProgress":
			return requireEntry(params.root).finder.getScanProgress();
		case "grep":
			return requireEntry(params.root).finder.grep(params.query, params.options);
		case "multiGrep":
			return requireEntry(params.root).finder.multiGrep(params.options);
		case "fileSearch":
			return requireEntry(params.root).finder.fileSearch(params.query, params.options);
		case "mixedSearch":
			return requireEntry(params.root).finder.mixedSearch(params.query, params.options);
		case "healthCheck": {
			const res = requireEntry(params.root).finder.healthCheck();
			if (res.ok) {
				return {
					ok: true,
					value: {
						...res.value,
						pid: process.pid,
						sharedRoots: entries.size,
					},
				};
			}
			return res;
		}
		case "scanFiles": {
			const res = requireEntry(params.root).finder.scanFiles();
			return res.ok ? { ok: true, value: true } : res;
		}
		default:
			throw new Error(`Unknown FFF sidecar method: ${String(method)}`);
	}
}

function sendReply(payload) {
	if (typeof process.send === "function" && process.connected) {
		try {
			process.send(payload);
		} catch {
			// Ignore IPC write races during disconnect.
		}
	}
}

process.on("message", (msg) => {
	if (!msg || typeof msg !== "object" || !("id" in msg)) {
		return;
	}
	const { id, method, params } = msg;
	void (async () => {
		try {
			const value = await handleMethod(method, params);
			sendReply({ id, ok: true, value });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendReply({ id, ok: false, error: message });
		}
	})();
});
