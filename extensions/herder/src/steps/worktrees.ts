// Shared read-only commit worktrees (ro-<sha12>) and pooled reusable write worktree slots (rw-<n>) per run.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { runPaths, worktreePath } from "../run/paths.ts";
import type { Vcs } from "../types.ts";

export const POOL_SLOT = /^(?:ro-[0-9a-f]{12,64}|rw-\d+)$/;

export interface WorktreeLease {
	readonly path: string;
	release(): void;
}

interface ReadOnlyState {
	commit: string;
	refCount: number;
}

const readOnlyLeases = new Map<string, ReadOnlyState>();
const activeWriteSlots = new Map<string, Set<number>>();

export const readOnlySlot = (commit: string): string => `ro-${commit.slice(0, 12)}`;
export const writeSlot = (slot: number): string => `rw-${slot}`;

/**
 * A quarantined write slot holds work no step ref captured; its marker file sits next to it, so it goes when the run's
 * worktrees are removed (abort, delivery, clean). Until then no lease, heal, or pool release touches the slot.
 */
const quarantineMarker = (path: string): string => `${path}.quarantined`;
const isQuarantined = (path: string): boolean => existsSync(quarantineMarker(path));

function recreateWorktree(vcs: Vcs, path: string, commit: string): void {
	if (!existsSync(path)) {
		try {
			vcs.addWorktree(path, commit);
			return;
		} catch {}
	}
	try { vcs.removeWorktree(path); } catch {}
	vcs.addWorktree(path, commit);
}

export function resetOrRecreateWorktree(vcs: Vcs, path: string, commit: string): void {
	if (existsSync(path) && vcs.resetWorktree) {
		try {
			vcs.resetWorktree(path, commit);
			return;
		} catch {}
	}
	recreateWorktree(vcs, path, commit);
}

function isCleanWorktreeAt(vcs: Vcs, path: string, commit: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return vcs.worktreeHead(path) === commit && vcs.isClean(path);
	} catch {
		return false;
	}
}

function makeReadOnlyLease(vcs: Vcs, path: string, state: ReadOnlyState): WorktreeLease {
	let released = false;
	return {
		path,
		release() {
			if (released) return;
			released = true;
			state.refCount = Math.max(0, state.refCount - 1);
			if (state.refCount === 0 && existsSync(path) && !isCleanWorktreeAt(vcs, path, state.commit)) {
				try {
					resetOrRecreateWorktree(vcs, path, state.commit);
				} catch {
					try { vcs.removeWorktree(path); } catch {}
				}
			}
		},
	};
}

/**
 * Leases a shared read-only worktree checked out at `commit` (`ro-<sha12>`). Concurrent callers at the same commit
 * share one worktree; once released (`refCount === 0`), the clean worktree stays cached under `worktrees/<runId>/`.
 */
export function acquireReadOnlyWorktree(vcs: Vcs, runId: string, commit: string): WorktreeLease {
	const sha = vcs.resolve(commit);
	let path = worktreePath(vcs.commonDir(), runId, readOnlySlot(sha));
	let state = readOnlyLeases.get(path);
	if (state && state.refCount > 0 && state.commit !== sha) {
		path = worktreePath(vcs.commonDir(), runId, `ro-${sha}`);
		state = readOnlyLeases.get(path);
	}
	if (!state || state.refCount === 0) {
		if (!existsSync(path)) recreateWorktree(vcs, path, sha);
		else if (!isCleanWorktreeAt(vcs, path, sha)) resetOrRecreateWorktree(vcs, path, sha);
		state = { commit: sha, refCount: 1 };
		readOnlyLeases.set(path, state);
	} else {
		if (!existsSync(path)) recreateWorktree(vcs, path, sha);
		state.refCount++;
	}
	return makeReadOnlyLease(vcs, path, state);
}

/**
 * Leases the lowest free write worktree slot (`rw-0`, `rw-1`, ...) for `(commonDir, runId)`, resetting an existing
 * slot in-place to `base` or creating it on first use.
 */
export function acquireWriteWorktree(vcs: Vcs, runId: string, base: string): WorktreeLease & { readonly slot: number; quarantine(note: string): void } {
	const sha = vcs.resolve(base);
	const dir = runPaths(vcs.commonDir(), runId).worktrees;
	let active = activeWriteSlots.get(dir);
	if (!active) activeWriteSlots.set(dir, active = new Set());
	let slot = 0;
	while (active.has(slot) || isQuarantined(join(dir, writeSlot(slot)))) slot++;
	active.add(slot);
	const path = worktreePath(vcs.commonDir(), runId, writeSlot(slot));
	try {
		if (existsSync(path)) resetOrRecreateWorktree(vcs, path, sha);
		else recreateWorktree(vcs, path, sha);
	} catch (error) {
		active.delete(slot);
		if (active.size === 0) activeWriteSlots.delete(dir);
		throw error;
	}
	let released = false;
	const free = () => {
		active.delete(slot);
		if (active.size === 0) activeWriteSlots.delete(dir);
	};
	return {
		path,
		slot,
		/** Releases the lease without resetting the slot and keeps it out of the pool; throws if the marker cannot be written. */
		quarantine(note) {
			if (released) throw new Error(`write slot ${path} was already released`);
			released = true;
			try {
				writeFileSync(quarantineMarker(path), `${note}\n`);
			} finally {
				free();
			}
		},
		release() {
			if (released) return;
			released = true;
			try {
				if (existsSync(path)) {
					let clean = false;
					try {
						vcs.worktreeHead(path);
						clean = vcs.isClean(path);
					} catch {
						clean = false;
					}
					if (!clean) {
						try {
							resetOrRecreateWorktree(vcs, path, sha);
						} catch {
							try { vcs.removeWorktree(path); } catch {}
						}
					}
				}
			} finally {
				free();
			}
		},
	};
}

/**
 * Called at launch startup when no step of the run is active: drops legacy `step-*` leftovers and heals or removes any
 * pooled `ro-*` / `rw-*` worktree left dirty or half-created by a crashed process, keeping valid clean slots warm.
 * Quarantined slots stay as they are.
 */
export function healRunWorktrees(vcs: Vcs, runId: string): void {
	const dir = runPaths(vcs.commonDir(), runId).worktrees;
	if (!existsSync(dir)) return;
	for (const slot of readdirSync(dir)) {
		let path: string;
		try { path = worktreePath(vcs.commonDir(), runId, slot); } catch { continue; }
		if (slot.startsWith("step-")) {
			try { vcs.removeWorktree(path); } catch {}
			continue;
		}
		if (!POOL_SLOT.test(slot) || isQuarantined(path)) continue;
		try {
			const head = vcs.worktreeHead(path);
			if (slot.startsWith("ro-") && !head.startsWith(slot.slice(3))) vcs.removeWorktree(path);
			else if (!vcs.isClean(path)) resetOrRecreateWorktree(vcs, path, head);
		} catch {
			try { vcs.removeWorktree(path); } catch {}
		}
	}
}

/** Drops cached in-memory pool bookkeeping for a run whose worktrees were removed. */
export function clearRunWorktreeState(commonDir: string, runId: string): void {
	const dir = runPaths(commonDir, runId).worktrees;
	activeWriteSlots.delete(dir);
	const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
	for (const [key, state] of readOnlyLeases) {
		if (key.startsWith(prefix) && state.refCount === 0) readOnlyLeases.delete(key);
	}
}

/** Removes cached `ro-*` and `rw-*` pool worktrees of a run (leaving non-pool and quarantined slots alone). */
export function releaseRunPoolWorktrees(vcs: Vcs, runId: string): void {
	const commonDir = vcs.commonDir();
	const dir = runPaths(commonDir, runId).worktrees;
	if (existsSync(dir)) {
		for (const slot of readdirSync(dir)) {
			if (!POOL_SLOT.test(slot)) continue;
			const path = worktreePath(commonDir, runId, slot);
			if (isQuarantined(path)) continue;
			try { vcs.removeWorktree(path); } catch {}
		}
	}
	clearRunWorktreeState(commonDir, runId);
}
