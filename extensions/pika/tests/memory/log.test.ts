import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type ExtensionUIContext, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LogViewer } from "../../log-viewer.ts";
import { currentDream } from "../../memory/dream/index.ts";
import { DREAM_ENTRY, type DreamRecord, PIN_ENTRY } from "../../memory/entries.ts";
import { indexNotes, type MemoryLogItem, memoryLogItems, memoryView } from "../../memory/log.ts";
import { FakePika } from "./support/pika-server.ts";
import { fakeSpawner, type FakeChild, LEASE_ID, RecordingUI, releases, resetDreams, serveDreams } from "./support/dream.ts";
import { callTool, type Harness, note, PROJECT, PROJECT_SCOPE, REPOSITORY, setCredentials, startSession, USER_SCOPE, Workspace } from "./support/runtime.ts";

const KEYS = { up: "\x1b[A", down: "\x1b[B", home: "\x1b[H", end: "\x1b[F", enter: "\r", esc: "\x1b" };
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const colorTheme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
/** A line without its frame, its clock as HH:MM. */
const inside = (line: string) => plain(line).replace(/^│ /, "").replace(/\s*│$/, "").replace(/\b\d\d:\d\d\b/, "HH:MM");

const INDEX = "# User memory\n## feedback\n- Tabs — use tabs [abc]\n# Project memory: my-project\n## project\n- Pitfall — run npm ci first [def]\n- Flaky — retry upload.test [ghi]\n";
const SAVE_ARGS = { expectedRevision: 0, scope: "project", category: "project", title: "Pitfall", hook: "run npm ci first", body: "Tests need node_modules.\nWhy: CI failed.", reason: "found it" };
const DREAM: DreamRecord = {
	leaseId: "lease-1", mode: "manual", outcome: "completed", reason: "finished", startedAt: "2026-11-10T09:10:00.000Z", endedAt: "2026-11-10T09:12:00.000Z", scope: PROJECT,
	sessions: ["s-1", "s-2"], batches: 1, notesChanged: 2, discarded: 1, uncertain: 0, turns: 4, tokens: 1234, childSessionId: "dream-1", model: "memory-test/test",
	changes: [{ noteId: "n-1", revision: 1, action: "save", created: true }, { noteId: "n-2", revision: 3, action: "forget", created: false }],
};

let n = 0;
const entry = (fields: object, timestamp = "2026-11-10T09:00:00.000Z"): SessionEntry => ({ id: `e${++n}`, parentId: null, timestamp, ...fields }) as SessionEntry;
const custom = (customType: string, data: unknown, timestamp?: string) => entry({ type: "custom", customType, data }, timestamp);
const assistant = (...calls: Record<string, unknown>[]) =>
	entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "calling" }, ...calls.map((call) => ({ type: "toolCall", ...call }))] } }, "2026-11-10T09:05:00.000Z");
const result = (toolCallId: string, text: string, fields: { isError?: boolean; details?: unknown } = {}) =>
	entry({ type: "message", message: { role: "toolResult", toolCallId, toolName: "memory", content: [{ type: "text", text }], isError: fields.isError ?? false, ...(fields.details !== undefined ? { details: fields.details } : {}), timestamp: 0 } });

/** A branch with a pin, the three memory tools (one refused, one never answered), and a dream. */
function branch(): SessionEntry[] {
	return [
		custom(PIN_ENTRY, { index: INDEX, fetchedAt: "2026-11-10T09:00:00.000Z", project: PROJECT, repository: REPOSITORY }),
		assistant(
			{ id: "c1", name: "memory_read", arguments: { query: "npm", scope: "project" } },
			{ id: "c2", name: "memory_save", arguments: SAVE_ARGS },
			{ id: "c3", name: "memory_save", arguments: { ...SAVE_ARGS, id: "[def]", expectedRevision: 2, title: "Pitfall again" } },
		),
		result("c1", "[memory] 1 note matching, of 3 in the user scope and project my-project.", { details: { noteIds: ["def"], total: 3 } }),
		result("c2", "Created note n-1 (now revision 1) in project my-project: Pitfall — run npm ci first\nThe memory section…", { details: { note: note({ id: "n-1", revision: 1 }), index: INDEX } }),
		result("c3", "revision_conflict: note def is at revision 3, not 2; it changed since you read it.", { isError: true, details: { error: "revision_conflict" } }),
		assistant({ id: "c4", name: "memory_forget", arguments: { id: "abc", expectedRevision: 1, reason: "obsolete" } }),
		custom(DREAM_ENTRY, DREAM, "2026-11-10T09:12:00.000Z"),
	];
}

describe("memoryLogItems", () => {
	it("reads pins, pairs memory tool calls with their results, reads dream entries, and skips what it cannot read", () => {
		const items = memoryLogItems([
			custom(PIN_ENTRY, { index: INDEX, fetchedAt: "2026-11-10T08:59:00.000Z", project: PROJECT, repository: REPOSITORY, extra: 1 }),
			custom(PIN_ENTRY, { index: null, fetchedAt: "", error: "pika is not logged in to a server" }, "2026-11-10T09:01:00.000Z"),
			custom(PIN_ENTRY, { index: 42, fetchedAt: "2026-11-10T09:00:00.000Z" }),
			custom(PIN_ENTRY, undefined),
			entry({ type: "message", message: { role: "user", content: "hello", timestamp: 0 } }),
			assistant(
				{ id: "c1", name: "memory_read", arguments: { query: "npm" } },
				{ id: "c2", name: "memory_save", arguments: SAVE_ARGS },
				{ id: "c3", name: "read", arguments: { path: "x" } },
				{ name: "memory_forget", arguments: { id: "no call id" } },
				{ id: "c4", name: "memory_forget", arguments: "not an object" },
			),
			result("c1", "read it", { details: { noteIds: ["def"], total: 3 } }),
			result("c2", "refused", { isError: true }),
			result("c3", "a file"),
			result("unknown", "no call"),
			result("c1", "a second result"),
			custom(DREAM_ENTRY, DREAM, "2026-11-10T09:13:00.000Z"),
			custom(DREAM_ENTRY, { outcome: "failed", sessions: ["s-1", 3], changes: [{ noteId: "n-9", action: "weird", title: "Kept" }, "junk"], batches: "two" }, "2026-11-10T09:14:00.000Z"),
			custom(DREAM_ENTRY, { reason: "no outcome" }),
			custom("relay-sent", { id: "msg-1", text: "not memory" }),
		]);
		expect(items).toEqual<MemoryLogItem[]>([
			{ kind: "pin", at: "2026-11-10T08:59:00.000Z", pin: { index: INDEX, fetchedAt: "2026-11-10T08:59:00.000Z", project: PROJECT, repository: REPOSITORY } },
			{ kind: "pin", at: "2026-11-10T09:01:00.000Z", pin: { index: null, fetchedAt: "", error: "pika is not logged in to a server" } },
			{ kind: "call", at: "2026-11-10T09:05:00.000Z", tool: "memory_read", id: "c1", args: { query: "npm" }, result: { text: "read it", isError: false, details: { noteIds: ["def"], total: 3 } } },
			{ kind: "call", at: "2026-11-10T09:05:00.000Z", tool: "memory_save", id: "c2", args: SAVE_ARGS, result: { text: "refused", isError: true } },
			{ kind: "call", at: "2026-11-10T09:05:00.000Z", tool: "memory_forget", id: "c4", args: {} },
			{ kind: "dream", at: "2026-11-10T09:12:00.000Z", dream: DREAM },
			{
				kind: "dream", at: "2026-11-10T09:14:00.000Z", dream: {
					leaseId: "", mode: "", outcome: "failed", reason: "", startedAt: "", endedAt: "", sessions: ["s-1"], batches: 0, notesChanged: 0, discarded: 0, uncertain: 0, turns: 0, tokens: 0, model: "",
					changes: [{ noteId: "n-9", revision: 0, action: "save", created: false, title: "Kept" }],
				} as unknown as DreamRecord,
			},
		]);
	});

	it("counts one note for every `- ` line of the index, not its headings", () => {
		expect(indexNotes(INDEX)).toBe(3);
		expect(indexNotes("")).toBe(0);
		expect(indexNotes("# User memory\n## user\n-not a note\n- Role — who [a]")).toBe(1);
	});
});

describe("the memory log view", () => {
	function viewer(items: readonly MemoryLogItem[], { rows = 60, mode = "regular" as "regular" | "fullscreen", theme = plainTheme } = {}) {
		const done = vi.fn();
		const view = new LogViewer({ mode, terminal: { rows }, requestRender: vi.fn() }, theme, undefined, memoryView(theme, items), done);
		return { view, done, press: (...input: string[]) => { for (const key of input) view.handleInput(key); }, text: (width = 100) => view.render(width).map(inside) };
	}
	/** The opened item's lines between its title and its footer. */
	const page = (text: string[]) => text.slice(3, -3);

	it("lists every event of the branch with its time and outcome, the newest selected", () => {
		const { text } = viewer(memoryLogItems(branch()));
		expect(text().slice(1, 9)).toEqual([
			"memory log · 6 events on this branch",
			`├${"─".repeat(98)}┤`,
			"  HH:MM  session start · 3 notes · 159 chars",
			"  HH:MM  memory_read \"npm\" · project scope  1 note",
			"  HH:MM  memory_save Pitfall · project · new  created · rev 1",
			// Rows are cut to the width.
			"  HH:MM  memory_save Pitfall again · project · update [def]  revision_conflict: note def is at …",
			"  HH:MM  memory_forget abc  no result",
			"▸ HH:MM  dream completed · 2 notes changed",
		]);
		expect(text().at(-2)).toBe("6/6 · ↑↓ move · Enter open · Esc close");
	});

	it("opens the pin with its fetch time, repository, and the whole index, or says the session has no memory section", () => {
		const { text, press } = viewer(memoryLogItems(branch()));
		press(KEYS.home, KEYS.enter);
		expect(text()[1]).toBe("memory log · event 1 of 6");
		expect(page(text())).toEqual([
			"Memory index pinned when the session started",
			expect.stringMatching(/^Fetched: \d{4}-\d\d-\d\d HH:MM:00$/),
			`Project: ${PROJECT}`,
			`Repository: ${REPOSITORY}`,
			"Notes: 3",
			"Size: 159 chars",
			"",
			...INDEX.trimEnd().split("\n"),
		]);

		const none = viewer(memoryLogItems([custom(PIN_ENTRY, { index: null, fetchedAt: "2026-11-10T09:00:00.000Z", error: "the pika server did not answer within 1.5 s" })]));
		expect(none.text()[3]).toBe("▸ HH:MM  session start · no memory section");
		none.press(KEYS.enter);
		expect(page(none.text())).toEqual([
			"No memory section: no index was pinned when the session started",
			expect.stringMatching(/^Fetched: /),
			"Error: the pika server did not answer within 1.5 s",
			"",
			"This session's system prompt has no memory section: pika pinned no index when it started, and it",
			"never gains one.",
		]);
		const empty = viewer(memoryLogItems([custom(PIN_ENTRY, { index: "", fetchedAt: "2026-11-10T09:00:00.000Z" })]));
		expect(empty.text()[3]).toBe("▸ HH:MM  session start · empty index, no memory section");
	});

	it("opens a call with every argument, its outcome, and its whole result; a save with its body; a call without a result as such", () => {
		const { text, press } = viewer(memoryLogItems(branch()));
		press(KEYS.home, KEYS.down, KEYS.enter);
		expect(page(text())).toEqual([
			"memory_read \"npm\" · project scope",
			expect.stringMatching(/^Time: \d{4}-\d\d-\d\d HH:MM:00$/),
			"Query: npm",
			"Scope: project",
			"Outcome: 1 note",
			"",
			"Result:",
			"[memory] 1 note matching, of 3 in the user scope and project my-project.",
		]);
		press(KEYS.esc, KEYS.down, KEYS.enter);
		expect(page(text())).toEqual([
			"memory_save Pitfall · project · new",
			expect.stringMatching(/^Time: /),
			"Scope: project",
			"Category: project",
			"Title: Pitfall",
			"Hook: run npm ci first",
			"Reason: found it",
			"Expected revision: 0",
			`Outcome: created · rev 1 · project ${PROJECT}`,
			"",
			"Body:",
			"Tests need node_modules.",
			"Why: CI failed.",
			"",
			"Result:",
			"Created note n-1 (now revision 1) in project my-project: Pitfall — run npm ci first",
			"The memory section…",
		]);
		press(KEYS.esc, KEYS.down, KEYS.enter);
		expect(page(text()).slice(0, 10)).toEqual([
			"memory_save Pitfall again · project · update [def]",
			expect.stringMatching(/^Time: /),
			"Scope: project", "Category: project", "Title: Pitfall again", "Hook: run npm ci first", "Reason: found it", "Id: [def]", "Expected revision: 2",
			"Outcome: revision_conflict: note def is at revision 3, not 2; it changed since you read it.",
		]);
		press(KEYS.esc, KEYS.down, KEYS.enter);
		expect(page(text())).toEqual([
			"memory_forget abc",
			expect.stringMatching(/^Time: /),
			"Id: abc",
			"Expected revision: 1",
			"Reason: obsolete",
			"Outcome: no result: the call was aborted, or is still running",
			"",
			"Result:",
			"None: the call was aborted, or is still running.",
		]);
		// Arguments the tool does not define are shown too.
		const odd = viewer(memoryLogItems([assistant({ id: "c9", name: "memory_read", arguments: { ids: ["a", "b"], limit: 5, nested: { deep: true } } })]));
		odd.press(KEYS.enter);
		expect(page(odd.text()).slice(2, 5)).toEqual(["Ids: a, b", "limit: 5", "nested: {deep:true}"]);
	});

	it("opens a dream with every field it recorded, the notes it changed, and the sessions it reviewed", () => {
		const { text, press } = viewer(memoryLogItems(branch()));
		press(KEYS.enter);
		expect(page(text())).toEqual([
			"dream completed",
			expect.stringMatching(/^Started: \d{4}-\d\d-\d\d HH:MM:00$/),
			expect.stringMatching(/^Ended: \d{4}-\d\d-\d\d HH:MM:00$/),
			"Reason: finished",
			"Mode: manual",
			`Project: ${PROJECT}`,
			"Lease: lease-1",
			"Sessions reviewed: 2",
			"Batches committed: 1",
			"Notes changed: 2",
			"Discarded changes: 1",
			"Changes with unknown outcome: 0",
			"Turns: 4",
			"Budget tokens: 1234",
			"Dream session: dream-1",
			"Model: memory-test/test",
			"",
			"Changes:",
			"- created [n-1] · rev 1",
			"- forgot [n-2] · rev 3",
			"",
			"Sessions reviewed:",
			"- s-1",
			"- s-2",
		]);
		// An entry that carries a note's title shows it.
		const titled = viewer(memoryLogItems([custom(DREAM_ENTRY, { ...DREAM, changes: [{ ...DREAM.changes[0], title: "Pitfall" }] })]));
		titled.press(KEYS.enter);
		expect(page(titled.text())).toContain("- created [n-1] Pitfall · rev 1");
	});

	it("strips terminal sequences and control characters from everything it shows", () => {
		const evil = "\x1b]0;pwned\x07\x1b[2J\x07\x1b[31m";
		const { view, press } = viewer(memoryLogItems([
			custom(PIN_ENTRY, { index: `- Tabs${evil} — hook [a]\n`, fetchedAt: "2026-11-10T09:00:00.000Z", project: `p${evil}`, error: `e${evil}` }),
			assistant({ id: "c1", name: "memory_save", arguments: { ...SAVE_ARGS, title: `T${evil}`, body: `b${evil}`, [`k${evil}`]: `v${evil}` } }),
			result("c1", `Created${evil}`, { details: { note: { revision: 1, scope: { kind: "project", label: `L${evil}` } } } }),
			custom(DREAM_ENTRY, { ...DREAM, reason: `r${evil}`, changes: [{ noteId: `n${evil}`, title: `t${evil}`, action: "save", revision: 1, created: true }] }),
		]));
		const shown: string[] = [];
		for (const step of [[], [KEYS.home, KEYS.enter], [KEYS.esc, KEYS.down, KEYS.enter], [KEYS.esc, KEYS.down, KEYS.enter]]) {
			press(...step);
			shown.push(...view.render(100));
		}
		expect(shown.join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
		expect(shown.join("\n")).toContain("Outcome: created · rev 1 · project L");
	});

	it("keeps every line within the width at any width, in both views and modes", () => {
		const long = "a long title that goes on ".repeat(20);
		const items = memoryLogItems([
			...branch(),
			assistant({ id: "c5", name: "memory_save", arguments: { ...SAVE_ARGS, title: long, hook: long, body: `${long}\n\t${"x".repeat(400)}` } }),
			result("c5", long, { isError: true }),
		]);
		for (const mode of ["regular", "fullscreen"] as const) {
			for (const width of [1, 5, 12, 40, 80, 133]) {
				const { view, press } = viewer(items, { rows: 24, mode, theme: colorTheme });
				const check = () => { for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width); };
				check();
				for (let index = 0; index < items.length; index++) {
					press(KEYS.home, ...Array<string>(index).fill(KEYS.down), KEYS.enter);
					check();
					press(KEYS.end);
					check();
					press(KEYS.esc);
				}
			}
		}
	});
});

/** A UI that records notifications and opens `ui.custom` components on a fake terminal. */
class LogUI extends RecordingUI {
	viewer: LogViewer | undefined;
	readonly tui = { mode: "regular" as const, terminal: { rows: 40 }, requestRender: vi.fn() };
	override context(): ExtensionUIContext {
		const base = super.context();
		const custom = (factory: (...args: unknown[]) => LogViewer) => new Promise((resolve) => { this.viewer = factory(this.tui, plainTheme, undefined, resolve); });
		return new Proxy(base, { get: (target, name) => name === "custom" ? custom : Reflect.get(target, name) });
	}
	lines(width = 100): string[] { return this.viewer!.render(width).map(inside); }
}

describe("in a session", () => {
	let workspace: Workspace;
	let pika: FakePika;
	const open: Harness[] = [];

	beforeEach(async () => {
		workspace = await Workspace.create();
		pika = await new FakePika().start();
		pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [], index: INDEX } });
		serveDreams(pika);
		setCredentials(pika.url);
		resetDreams();
	});
	afterEach(async () => {
		currentDream()?.stop("stopped", "the test ended");
		await currentDream()?.done;
		for (const h of open.splice(0)) await h.shutdown();
		resetDreams();
		await pika.stop();
		await workspace.cleanup();
	});

	async function start(options: Omit<Parameters<typeof startSession>[0], "workspace"> = {}): Promise<Harness> {
		const h = await startSession({ workspace, ...options });
		open.push(h);
		return h;
	}
	async function until(check: () => boolean, what: string): Promise<void> {
		const deadline = performance.now() + 5_000;
		while (performance.now() < deadline) {
			if (check()) return;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		throw new Error(`timed out waiting for ${what}`);
	}
	const dreams = (entries: readonly SessionEntry[]) => entries.flatMap((e) => e.type === "custom" && e.customType === DREAM_ENTRY ? [e.data as DreamRecord] : []);

	describe("/memory log", () => {
		it("opens only in the TUI, and says when the branch has no memory activity", async () => {
			const ui = new RecordingUI();
			const rpc = await start({ ui: ui.context() });
			await rpc.run("one");
			await rpc.session.prompt("/memory log");
			expect(ui.notes.at(-1)).toEqual({ message: "/memory log opens only in the interactive TUI.", type: "info" });

			const tui = new LogUI();
			const h = await start({ mode: "tui", ui: tui.context() });
			await h.session.prompt("/memory log");
			expect(tui.notes.at(-1)).toEqual({ message: "No memory activity on this branch.", type: "info" });
			expect(tui.viewer).toBeUndefined();
			await h.session.prompt("/memory log now");
			expect(tui.notes.at(-1)).toEqual({ message: "Usage: /memory [status|dream|stop|log]", type: "error" });
		});

		it("lists the branch's pin and memory tool calls with their results, and opens each one", async () => {
			const created = note({ id: "n-1", title: "Pitfall", hook: "run npm ci first" });
			pika.routes.set("POST memory/notes", { body: { note: created, index: INDEX, indexBytes: INDEX.length, indexLines: 7 } });
			pika.routes.set("POST memory/notes/abc/forget", { status: 409, body: { error: "revision_conflict", note: note({ id: "abc", revision: 4 }) } });
			const ui = new LogUI();
			const h = await start({ mode: "tui", ui: ui.context() });
			await callTool(h, "memory_save", SAVE_ARGS);
			await callTool(h, "memory_forget", { id: "abc", expectedRevision: 3 });

			const opened = h.session.prompt("/memory log");
			await until(() => ui.viewer !== undefined, "the viewer");
			expect(ui.lines().slice(1, 7)).toEqual([
				"memory log · 3 events on this branch",
				`├${"─".repeat(98)}┤`,
				"  HH:MM  session start · 3 notes · 159 chars",
				"  HH:MM  memory_save Pitfall · project · new  created · rev 1",
				"▸ HH:MM  memory_forget abc  revision_conflict: note abc is at revision 4, not 3; it changed sin…",
				`├${"─".repeat(98)}┤`,
			]);
			ui.viewer!.handleInput(KEYS.up);
			ui.viewer!.handleInput(KEYS.enter);
			expect(ui.lines().slice(3, 12)).toEqual([
				"memory_save Pitfall · project · new", expect.stringMatching(/^Time: /), "Scope: project", "Category: project", "Title: Pitfall", "Hook: run npm ci first",
				"Reason: found it", "Expected revision: 0", `Outcome: created · rev 1 · project ${PROJECT}`,
			]);
			ui.viewer!.handleInput("q");
			ui.viewer!.handleInput("q");
			await opened;

			// Another branch, from before the first run, has none of it.
			h.session.sessionManager.resetLeaf();
			ui.viewer = undefined;
			await h.session.prompt("/memory log");
			expect(ui.notes.at(-1)).toEqual({ message: "No memory activity on this branch.", type: "info" });
			expect(ui.viewer).toBeUndefined();
		});

		it("is offered in the completions and the usage", async () => {
			const ui = new RecordingUI();
			const h = await start({ ui: ui.context() });
			const command = h.session.extensionRunner.getCommand("memory")!;
			expect((await command.getArgumentCompletions!(""))!.map((item) => item.value)).toEqual(["status", "dream", "stop", "log"]);
			expect(await command.getArgumentCompletions!("l")).toEqual([{ value: "log", label: "log" }]);
			expect(await command.getArgumentCompletions!("log")).toBeNull();
			await h.session.prompt("/memory nap");
			expect(ui.notes.at(-1)).toEqual({ message: "Usage: /memory [status|dream|stop|log]", type: "error" });
		});
	});

	describe("the dream entry", () => {
		const SAVE = { ...SAVE_ARGS, sources: [{ sessionId: "s-past-1", seq: 7 }] };
		async function dream(h: Harness, spawner: ReturnType<typeof fakeSpawner>): Promise<FakeChild> {
			await h.session.prompt("/memory dream");
			await until(() => spawner.children.at(-1)?.prompts.length === 1, "the kickoff");
			return spawner.children.at(-1)!;
		}
		const ended = async (count = 1) => { await until(() => releases(pika).length === count, "the release"); await currentDream()?.done; };

		it("records how a completed, stopped, or failed dream ended in the session that asked for it, never for the model", async () => {
			const spawner = fakeSpawner();
			const h = await start({ ui: new RecordingUI().context() });
			const child = await dream(h, spawner);
			await child.call("dream_save", SAVE);
			expect((await child.call("dream_commit", { sessions: ["s-past-1"] })).isError).toBe(false);
			child.emit({ type: "turn_end", toolCalls: true });
			child.finish();
			await ended();
			const iso = expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/);
			expect(dreams(h.session.sessionManager.getBranch())).toEqual([{
				leaseId: LEASE_ID, mode: "manual", outcome: "completed", reason: "finished", startedAt: iso, endedAt: currentDream()!.endedAt, scope: PROJECT,
				sessions: ["s-past-1"], batches: 1, notesChanged: 1, discarded: 0, uncertain: 0, turns: 1, tokens: 0, childSessionId: "dream-child-1", model: "memory-test/test",
				changes: [{ noteId: "aaaaaaaaaaaa", revision: 1, action: "save", created: true }],
			}]);
			// The server shows custom entries other than the pin where it omits memory, so no note's text is in it.
			expect(JSON.stringify(dreams(h.session.sessionManager.getBranch()))).not.toContain("Pitfall");

			await dream(h, spawner);
			await h.session.prompt("/memory stop");
			await ended(2);
			const failing = await dream(h, spawner);
			await failing.call("dream_save", SAVE);
			failing.finish({ stopReason: "error", errorMessage: "overloaded" });
			await ended(3);
			expect(dreams(h.session.sessionManager.getBranch()).slice(1).map(({ outcome, reason, batches, discarded }) => ({ outcome, reason, batches, discarded }))).toEqual([
				{ outcome: "aborted", reason: "stopped with /memory stop", batches: 0, discarded: 0 },
				{ outcome: "failed", reason: "its model failed: overloaded", batches: 0, discarded: 1 },
			]);
			expect(memoryLogItems(h.session.sessionManager.getBranch()).filter((item) => item.kind === "dream")).toHaveLength(3);

			// The entries never reach the model.
			await h.run("next");
			expect(h.session.messages.some((message) => (message as { customType?: string }).customType === DREAM_ENTRY)).toBe(false);
			expect(JSON.stringify(h.session.messages)).not.toContain(LEASE_ID);
		});

		it("records a dream that quitting stopped in the session file", async () => {
			const spawner = fakeSpawner();
			const h = await start({ ui: new RecordingUI().context() });
			await h.run("one");
			const file = h.session.sessionManager.getSessionFile()!;
			await dream(h, spawner);
			await h.shutdown();
			await ended();
			expect(dreams(SessionManager.open(file).getEntries())).toEqual([expect.objectContaining({ outcome: "aborted", reason: "the session ended", leaseId: LEASE_ID })]);
		});

		it("records nothing once the user switched to another session", async () => {
			const spawner = fakeSpawner();
			const h = await start({ ui: new RecordingUI().context() });
			await h.run("one");
			const file = h.session.sessionManager.getSessionFile()!;
			await dream(h, spawner);
			await h.runtime.newSession();
			await ended();
			expect(currentDream()).toMatchObject({ outcome: "aborted", reason: "the session ended" });
			expect(dreams(SessionManager.open(file).getEntries())).toEqual([]);
			expect(dreams(h.session.sessionManager.getEntries())).toEqual([]);
		});

		it("records nothing in a child session", async () => {
			const spawner = fakeSpawner();
			const linked = SessionManager.create(workspace.cwd, workspace.sessionDir);
			linked.appendCustomEntry("pi-extensions.session-link", { kind: "subagent", parentSessionId: "parent" });
			const sessions = [await start({ sessionManager: linked }), await start({ bindAsChild: true })];
			for (const [index, h] of sessions.entries()) {
				(await dream(h, spawner)).finish();
				await ended(index + 1);
				expect(currentDream()).toMatchObject({ outcome: "completed" });
				expect(dreams(h.session.sessionManager.getEntries())).toEqual([]);
			}
		});
	});
});
