import fs from "node:fs";
import path from "node:path";

const MAX_AUX = 16;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const parsedMaxDeadHandles = Number.parseInt(
	process.env.PI_FFF_MAX_DEAD_HANDLES ?? "",
	10,
);
const MAX_DEAD_HANDLES =
	Number.isFinite(parsedMaxDeadHandles) && parsedMaxDeadHandles >= 1
		? parsedMaxDeadHandles
		: 8;

process.on("disconnect", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const entries = new Map();
const pending = new Map();

let dbDisabled = false;
let lastDbFallbackError = undefined;
let lastDbPathsKey = null;
let lastTick = 0;
let fileFinderPromise = null;
let deadHandleCount = 0;
let inFlightRpcCount = 0;
let recycleScheduled = false;

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

function readGitHeadState(root) {
	try {
		const dotGit = path.join(root, ".git");
		const stat = fs.statSync(dotGit);
		let gitdir;
		if (stat.isDirectory()) {
			gitdir = dotGit;
		} else if (stat.isFile()) {
			const content = fs.readFileSync(dotGit, "utf8");
			const match = content.match(/^gitdir:\s*(.+)$/m);
			if (!match || !match[1]) {
				return null;
			}
			gitdir = path.resolve(root, match[1].trim());
		} else {
			return null;
		}
		return fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
	} catch {
		return null;
	}
}

function sweepMissingRoots() {
	for (const [root, entry] of entries.entries()) {
		if (!fs.existsSync(entry.root)) {
			entries.delete(root);
			deadHandleCount++;
		}
	}
}

async function refreshEntryIfHeadChanged(entry, waitTimeoutMs) {
	const currentHead = readGitHeadState(entry.root);
	if (
		currentHead !== null &&
		entry.headState !== null &&
		currentHead !== entry.headState
	) {
		entry.headState = currentHead;
		if (entry.refreshPromise) {
			await entry.refreshPromise;
			return refreshEntryIfHeadChanged(entry, waitTimeoutMs);
		}
		const task = (async () => {
			entry.finder.scanFiles();
			await entry.finder.waitForScan(waitTimeoutMs);
		})();
		entry.refreshPromise = task;
		try {
			await task;
		} finally {
			if (entry.refreshPromise === task) {
				entry.refreshPromise = null;
			}
		}
		return;
	}
	if (entry.refreshPromise) {
		await entry.refreshPromise;
	}
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

	sweepMissingRoots();

	const target = canonicalizeRoot(params.basePath);
	const isWorkspace = params.kind === "workspace";
	const exact = isWorkspace || params.exact === true;
	const configKey = makeConfigKey(params);
	const dbPathsKey = makeDbPathsKey(params);
	const hasDbPaths = Boolean(params.frecencyDbPath || params.historyDbPath);
	const waitTimeoutMs = params.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

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
				await refreshEntryIfHeadChanged(entry, waitTimeoutMs);
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
				await refreshEntryIfHeadChanged(existing, waitTimeoutMs);
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
			await refreshEntryIfHeadChanged(entry, waitTimeoutMs);
			entry.lastUsed = nextTick();
			return buildEnsureResult(entry.root, false);
		}

		if (bestEntry) {
			await refreshEntryIfHeadChanged(bestEntry, waitTimeoutMs);
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
		await finder.waitForScan(waitTimeoutMs);

		const entry = {
			root: target,
			finder,
			pinned: pendingRecord.pinned,
			lastUsed: nextTick(),
			configKey,
			dbPathsKey,
			headState: readGitHeadState(target),
			refreshPromise: null,
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
			sweepMissingRoots();
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
	inFlightRpcCount++;
	void (async () => {
		try {
			const value = await handleMethod(method, params);
			sendReply({ id, ok: true, value });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendReply({ id, ok: false, error: message });
		} finally {
			inFlightRpcCount--;
			if (
				!recycleScheduled &&
				deadHandleCount >= MAX_DEAD_HANDLES &&
				inFlightRpcCount === 0 &&
				pending.size === 0
			) {
				recycleScheduled = true;
				setImmediate(() => {
					recycleScheduled = false;
					if (inFlightRpcCount === 0 && pending.size === 0) {
						process.exit(0);
					}
				});
			}
		}
	})();
});
