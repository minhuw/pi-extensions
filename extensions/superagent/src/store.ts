// The ticket store under `<git-common-dir>/superagent/`; see DESIGN.md "Tickets" and "Ownership and restarts".
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { LOCK_STALE_MS, type LockOwner, type NewTicket, type Ticket, type TicketEvent, type TicketStore } from "./types.ts";

const SLUG_MAX = 40;
/** A lock file that cannot be parsed counts as stale only after this long (its creator may still be writing it). */
const UNREADABLE_LOCK_GRACE_MS = 5_000;

/** The title lowercased, non-alphanumerics collapsed to `-`, trimmed, at most 40 characters; `ticket` when empty. */
export function slugify(title: string): string {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, SLUG_MAX).replace(/-+$/, "");
	return slug || "ticket";
}

/** Branch names for a ticket in order of preference: `pi/<id>-<slug>`, `pi/<id>-<slug>-2`, … (endless). */
export function* branchCandidates(id: number, slug: string): Generator<string> {
	const base = `pi/${id}-${slug}`;
	yield base;
	for (let n = 2; ; n++) yield `${base}-${n}`;
}

/** True when a process with `pid` exists; EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errno(error) === "EPERM";
	}
}

function errno(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function tempName(path: string): string {
	return `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

function writeAtomic(path: string, data: string): void {
	const temp = tempName(path);
	try {
		writeFileSync(temp, data);
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		throw error;
	}
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function isTicket(value: unknown, id: number): value is Ticket {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const t = value as Record<string, unknown>;
	return (
		t.version === 1 &&
		t.id === id &&
		typeof t.title === "string" &&
		typeof t.state === "string" &&
		typeof t.branch === "string" &&
		typeof t.worktree === "string"
	);
}

interface LockFile extends LockOwner {
	heartbeat: number;
}

/** A lock file on disk: missing, or present with its parsed content (undefined when unreadable) and mtime. */
type LockState = "missing" | { lock?: LockFile; mtime: number };

function readLock(path: string): LockState {
	let mtime: number;
	let text: string;
	try {
		mtime = statSync(path).mtimeMs;
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (errno(error) === "ENOENT") return "missing";
		throw error;
	}
	let lock: LockFile | undefined;
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		if (
			value &&
			typeof value === "object" &&
			typeof value.pid === "number" &&
			typeof value.sessionId === "string" &&
			typeof value.heartbeat === "number"
		) {
			lock = { pid: value.pid, sessionId: value.sessionId, heartbeat: value.heartbeat };
		}
	} catch {}
	return { lock, mtime };
}

function isStale(state: Exclude<LockState, "missing">, now = Date.now()): boolean {
	if (!state.lock) return now - state.mtime > UNREADABLE_LOCK_GRACE_MS;
	return now - state.lock.heartbeat > LOCK_STALE_MS || !pidAlive(state.lock.pid);
}

function sameOwner(a: LockOwner, b: LockOwner): boolean {
	return a.pid === b.pid && a.sessionId === b.sessionId;
}

function lockJson(owner: LockOwner): string {
	const lock: LockFile = { pid: owner.pid, sessionId: owner.sessionId, heartbeat: Date.now() };
	return `${JSON.stringify(lock)}\n`;
}

export function openStore(commonDir: string): TicketStore {
	const root = join(commonDir, "superagent");
	const ticketsDir = join(root, "tickets");
	const sessionsDir = join(root, "sessions");
	const worktreesDir = join(root, "worktrees");
	mkdirSync(ticketsDir, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });

	const dirOf = (id: number) => join(ticketsDir, String(id));
	const ticketPath = (id: number) => join(dirOf(id), "ticket.json");
	const eventsPath = (id: number) => join(dirOf(id), "events.jsonl");
	const lockPath = (id: number) => join(dirOf(id), "lock");

	function ids(): number[] {
		return readdirSync(ticketsDir)
			.filter((name) => /^[1-9][0-9]*$/.test(name))
			.map(Number)
			.sort((a, b) => a - b);
	}

	function append(id: number, event: Omit<TicketEvent, "at">): void {
		appendFileSync(eventsPath(id), `${JSON.stringify({ at: Date.now(), ...event })}\n`);
	}

	function write(ticket: Ticket): void {
		writeAtomic(ticketPath(ticket.id), `${JSON.stringify(ticket, null, "\t")}\n`);
	}

	function get(id: number): Ticket | undefined {
		if (!Number.isInteger(id) || id <= 0) return undefined;
		const value = readJson(ticketPath(id));
		return isTicket(value, id) ? value : undefined;
	}

	function requireTicketDir(id: number): void {
		if (!Number.isInteger(id) || id <= 0 || !existsSync(dirOf(id))) throw new Error(`superagent: unknown ticket #${id}`);
	}

	const store: TicketStore = {
		root,
		sessionsDir,

		create(init: NewTicket, owner: string): Ticket {
			const slug = slugify(init.title);
			let id = (ids().at(-1) ?? 0) + 1;
			for (; ; id++) {
				try {
					mkdirSync(dirOf(id));
					break;
				} catch (error) {
					if (errno(error) !== "EEXIST") throw error;
				}
			}
			const now = Date.now();
			const ticket: Ticket = {
				version: 1,
				id,
				slug,
				title: init.title,
				request: init.request,
				source: init.source,
				...(init.note !== undefined ? { note: init.note } : {}),
				createdAt: now,
				updatedAt: now,
				createdBy: init.createdBy,
				owner,
				...(init.workspace === "shared" ? { workspace: "shared" as const } : {}),
				base: init.base,
				...(init.target !== undefined ? { target: init.target } : {}),
				branch: init.branch ?? `pi/${id}-${slug}`,
				worktree: init.worktree ?? join(worktreesDir, `${id}-${slug}`),
				state: "queued",
			};
			write(ticket);
			append(id, { type: "created", title: ticket.title, owner, branch: ticket.branch, ...(ticket.workspace ? { workspace: ticket.workspace } : {}) });
			return ticket;
		},

		get,

		list(): Ticket[] {
			const tickets: Ticket[] = [];
			for (const id of ids()) {
				const ticket = get(id);
				if (ticket) tickets.push(ticket);
			}
			return tickets;
		},

		update(id: number, patch: Partial<Ticket>, event?: Omit<TicketEvent, "at">): Ticket {
			const current = get(id);
			if (!current) throw new Error(`superagent: unknown ticket #${id}`);
			const next: Record<string, unknown> = { ...current };
			for (const [key, value] of Object.entries(patch)) {
				if (value === undefined) delete next[key];
				else next[key] = value;
			}
			next.version = 1;
			next.id = id;
			// Strictly increasing, so two updates within one millisecond still order.
			next.updatedAt = Math.max(Date.now(), current.updatedAt + 1);
			const ticket = next as unknown as Ticket;
			write(ticket);
			if (event) append(id, event);
			return ticket;
		},

		events(id: number): TicketEvent[] {
			let text: string;
			try {
				text = readFileSync(eventsPath(id), "utf8");
			} catch {
				return [];
			}
			const events: TicketEvent[] = [];
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					const value = JSON.parse(line) as unknown;
					if (value && typeof value === "object" && typeof (value as TicketEvent).type === "string" && typeof (value as TicketEvent).at === "number") {
						events.push(value as TicketEvent);
					}
				} catch {}
			}
			return events;
		},

		acquire(id: number, owner: LockOwner): boolean {
			requireTicketDir(id);
			const path = lockPath(id);
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					const fd = openSync(path, "wx");
					try {
						writeSync(fd, lockJson(owner));
					} finally {
						closeSync(fd);
					}
					return true;
				} catch (error) {
					if (errno(error) !== "EEXIST") throw error;
				}
				const state = readLock(path);
				if (state === "missing") continue;
				if (state.lock && sameOwner(state.lock, owner)) {
					writeAtomic(path, lockJson(owner));
					return true;
				}
				if (!isStale(state)) return false;
				// Take over: move the stale lock aside, then check that what was moved is still the stale one (another
				// process may have taken it over between our read and the rename).
				const aside = `${tempName(path)}.stale`;
				try {
					renameSync(path, aside);
				} catch (error) {
					if (errno(error) === "ENOENT") continue;
					throw error;
				}
				const moved = readLock(aside);
				if (moved !== "missing" && !isStale(moved)) {
					try {
						linkSync(aside, path);
					} catch {}
					try {
						unlinkSync(aside);
					} catch {}
					return false;
				}
				try {
					unlinkSync(aside);
				} catch {}
			}
			return false;
		},

		refresh(id: number, owner: LockOwner): void {
			const state = readLock(lockPath(id));
			if (state !== "missing" && state.lock && sameOwner(state.lock, owner)) {
				writeAtomic(lockPath(id), lockJson(owner));
				return;
			}
			// Lost (removed, or stale and free to retake): take it again; held by another live owner: say so.
			if (!store.acquire(id, owner)) throw new Error(`superagent: the lock of ticket #${id} is held by another session`);
		},

		release(id: number, owner: LockOwner): void {
			const state = readLock(lockPath(id));
			if (state === "missing" || !state.lock || !sameOwner(state.lock, owner)) return;
			try {
				unlinkSync(lockPath(id));
			} catch (error) {
				if (errno(error) !== "ENOENT") throw error;
			}
		},

		holder(id: number): LockOwner | undefined {
			if (!Number.isInteger(id) || id <= 0) return undefined;
			const state = readLock(lockPath(id));
			if (state === "missing" || !state.lock || isStale(state)) return undefined;
			return { pid: state.lock.pid, sessionId: state.lock.sessionId };
		},
	};
	return store;
}
