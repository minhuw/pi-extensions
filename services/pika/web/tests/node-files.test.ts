import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeChannel } from "../src/nodes/channel";
import { EditorStore, isDirty, paneRequest, type FileTab } from "../src/nodes/editor";
import { NodeFiles } from "../src/nodes/files";
import { languageFor } from "../src/nodes/language";
import { LAYOUT_DEFAULTS, LAYOUT_KEY, loadLayout, saveLayout } from "../src/nodes/layout";
import { clientIdentity, MemoryKeyStore } from "../src/nodes/identity";
import { FileTree, rootFor, TREE_WATCH_BUDGET, visibleEntries } from "../src/nodes/tree";
import { FakeFs } from "./support/fakeFs";
import { FakeNode, settle } from "./support/fakeNode";

beforeAll(() => {
	vi.stubGlobal("crypto", webcrypto);
});

let node: FakeNode;
let fs: FakeFs;
let files: NodeFiles;
const disposers: (() => void)[] = [];

/** A ready, pinned channel to a fake node whose files live in `fs`. */
let channel: NodeChannel;
async function connect(): Promise<NodeFiles> {
	const identity = await clientIdentity(new MemoryKeyStore());
	node.allowed.add(identity.fingerprint);
	channel = new NodeChannel(node.route(), { identity, pinned: node.identity.fingerprint });
	await channel.start();
	await settle();
	expect(channel.state.kind).toBe("ready");
	const next = new NodeFiles(channel);
	disposers.push(() => next.dispose());
	return next;
}

beforeEach(async () => {
	node = await FakeNode.create("node-1");
	fs = new FakeFs(node);
	files = await connect();
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

/** Waits, a macrotask at a time, until `check` holds; a loaded machine needs more rounds than `settle` gives. */
async function until(check: () => boolean, what: string): Promise<void> {
	for (let round = 0; round < 2_000; round++) {
		if (check()) return;
		await settle(1);
	}
	throw new Error(`timed out waiting for ${what}`);
}

const fileTab = (store: EditorStore, path: string): FileTab => {
	const tab = store.tab(`file:${path}`);
	if (tab?.kind !== "file") throw new Error(`no file tab for ${path}`);
	return tab;
};

describe("the file tree", () => {
	it("lists the root, loads directories when expanded, and refreshes on fs.changed", async () => {
		fs.put("/repo/README.md", "# hi");
		fs.put("/repo/src/a.ts", "a");
		fs.put("/repo/.env", "SECRET=1");
		const tree = new FileTree(files, "/repo");
		disposers.push(() => tree.dispose());
		await settle();
		const root = tree.getSnapshot().dirs.get("/repo")!;
		expect(root.status).toBe("ready");
		expect(root.watched).toBe(true);
		expect(visibleEntries(root.entries, false).map((entry) => entry.name)).toEqual(["src", "README.md"]);
		expect(visibleEntries(root.entries, true).map((entry) => entry.name)).toEqual(["src", ".env", "README.md"]);
		// Nothing below the root is read before it is expanded.
		expect(node.received.filter((message) => message.type === "fs.readDir").map((message) => "path" in message && message.path)).toEqual(["/repo"]);

		tree.expand("/repo/src");
		await settle();
		expect(tree.getSnapshot().dirs.get("/repo/src")!.entries.map((entry) => entry.name)).toEqual(["a.ts"]);

		fs.put("/repo/src/b.ts", "b");
		await settle();
		expect(tree.getSnapshot().dirs.get("/repo/src")!.entries.map((entry) => entry.name)).toEqual(["a.ts", "b.ts"]);

		tree.collapse("/repo/src");
		await settle();
		expect(tree.getSnapshot().dirs.has("/repo/src")).toBe(false);
		expect([...fs.watches.values()]).toEqual(["/repo"]);
	});

	it("shows that the node cut a long listing short", async () => {
		fs.maxEntries = 3;
		for (const name of ["a", "b", "c", "d", "e"]) fs.put(`/big/${name}`, name);
		const tree = new FileTree(files, "/big");
		disposers.push(() => tree.dispose());
		await settle();
		const view = tree.getSnapshot().dirs.get("/big")!;
		expect(view.truncated).toBe(true);
		expect(view.entries).toHaveLength(3);
	});

	it("reports a directory it cannot list, and keeps its watches within budget", async () => {
		fs.put("/repo/file.txt", "x");
		const tree = new FileTree(files, "/repo/missing");
		disposers.push(() => tree.dispose());
		await settle();
		expect(tree.getSnapshot().dirs.get("/repo/missing")).toMatchObject({ status: "failed", error: expect.stringMatching(/^not_found/), watched: false });

		for (let i = 0; i < TREE_WATCH_BUDGET + 5; i++) fs.put(`/many/d${String(i).padStart(2, "0")}/f`, "x");
		const many = new FileTree(files, "/many");
		disposers.push(() => many.dispose());
		for (let i = 0; i < TREE_WATCH_BUDGET + 5; i++) many.expand(`/many/d${String(i).padStart(2, "0")}`);
		await until(() => [...many.getSnapshot().dirs.values()].every((dir) => dir.status === "ready"), "every listing");
		await settle();
		expect(fs.watches.size).toBeLessThanOrEqual(TREE_WATCH_BUDGET + 1);
		expect(many.getSnapshot().dirs.get("/many/d44")).toMatchObject({ status: "ready", watched: false });
	});
});

describe("editor tabs", () => {
	it("opens text, and says why it does not open binary, large, or missing files", async () => {
		fs.put("/repo/a.ts", "const a = 1;\n");
		fs.put("/repo/logo.png", "", { binary: true });
		fs.put("/repo/big.log", "x".repeat(512 * 1024 + 1));
		const store = new EditorStore();
		store.setFiles(files);
		await store.open("/repo/a.ts");
		await store.open("/repo/logo.png");
		await store.open("/repo/big.log");
		await store.open("/repo/gone.txt");
		expect(store.getSnapshot().tabs.map((tab) => (tab.kind === "file" ? tab.body.kind : tab.kind))).toEqual(["text", "binary", "too_large", "missing"]);
		expect(store.getSnapshot().active).toBe("file:/repo/gone.txt");
		await settle();
		expect(fileTab(store, "/repo/a.ts").watched).toBe(true);
		store.close("file:/repo/gone.txt");
		expect(store.getSnapshot().active).toBe("file:/repo/big.log");
		store.dispose();
	});

	it("saves with the mtime and size it read, marks the tab dirty until then, and swallows the save's echo", async () => {
		fs.put("/repo/a.ts", "one");
		const store = new EditorStore({ echoWindowMs: 200 });
		store.setFiles(files);
		await store.open("/repo/a.ts");
		await settle();
		const before = fs.stat("/repo/a.ts")!;
		store.edit("file:/repo/a.ts", "two");
		expect(isDirty(fileTab(store, "/repo/a.ts"))).toBe(true);
		expect(await store.save("file:/repo/a.ts")).toBe("saved");
		expect(fs.writes).toEqual([{ path: "/repo/a.ts", expected: { mtimeMs: before.mtimeMs, size: before.size } }]);
		expect(fs.files.get("/repo/a.ts")!.data).toBe("two");
		expect(isDirty(fileTab(store, "/repo/a.ts"))).toBe(false);
		await settle();
		const reads = () => node.received.filter((message) => message.type === "fs.read").length;
		// The save's own fs.changed reads nothing within the window...
		const readsAfterSave = reads();
		fs.changed("/repo/a.ts");
		await settle();
		expect(reads()).toBe(readsAfterSave);
		// ...and, as something changed during it, the file is read once when it ends: unchanged, so nothing to show.
		await new Promise((resolve) => setTimeout(resolve, 250));
		await settle();
		expect(reads()).toBe(readsAfterSave + 1);
		expect(fileTab(store, "/repo/a.ts").disk).toBeUndefined();
		// A second save uses the stat of the first.
		store.edit("file:/repo/a.ts", "three");
		expect(await store.save("file:/repo/a.ts")).toBe("saved");
		expect(fs.writes[1]!.expected).toEqual({ mtimeMs: fs.stat("/repo/a.ts")!.mtimeMs - 10, size: 3 });
		store.dispose();
	});

	it("still sees a real change hidden behind the save's echo", async () => {
		fs.put("/repo/a.ts", "one");
		const store = new EditorStore({ echoWindowMs: 150 });
		store.setFiles(files);
		await store.open("/repo/a.ts");
		store.edit("file:/repo/a.ts", "two");
		await store.save("file:/repo/a.ts");
		fs.put("/repo/a.ts", "from the shell");
		await settle();
		expect(fileTab(store, "/repo/a.ts").body).toMatchObject({ text: "two" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		await settle();
		// A clean buffer follows the file.
		expect(fileTab(store, "/repo/a.ts").body).toMatchObject({ kind: "text", text: "from the shell", saved: "from the shell" });
		store.dispose();
	});

	it("reloads a clean buffer on an external change, and keeps a dirty one with the change beside it", async () => {
		fs.put("/repo/a.ts", "one");
		const store = new EditorStore({ echoWindowMs: 50 });
		store.setFiles(files);
		await store.open("/repo/a.ts");
		await settle();
		fs.put("/repo/a.ts", "two");
		await settle();
		expect(fileTab(store, "/repo/a.ts").body).toMatchObject({ text: "two", saved: "two" });

		store.edit("file:/repo/a.ts", "mine");
		fs.put("/repo/a.ts", "theirs");
		await settle();
		const tab = fileTab(store, "/repo/a.ts");
		expect(tab.body).toMatchObject({ text: "mine" });
		expect(tab.disk).toMatchObject({ kind: "changed", text: "theirs" });

		// A touch that keeps the content adopts the new stat and shows nothing.
		store.reload("file:/repo/a.ts");
		await settle();
		const mtime = fileTab(store, "/repo/a.ts").body.kind === "text" && (fileTab(store, "/repo/a.ts").body as { stat: { mtimeMs: number } }).stat.mtimeMs;
		fs.put("/repo/a.ts", "theirs");
		await settle();
		const touched = fileTab(store, "/repo/a.ts");
		expect(touched.disk).toBeUndefined();
		expect(touched.body.kind === "text" && touched.body.stat.mtimeMs).toBeGreaterThan(mtime as number);
		store.dispose();
	});

	it("turns a refused save into a conflict: compare reads the disk, overwrite writes over its stat, reload drops the edits", async () => {
		fs.put("/repo/a.ts", "base");
		const store = new EditorStore({ echoWindowMs: 50 });
		store.setFiles(files);
		await store.open("/repo/a.ts");
		// Changed behind the watch's back: the daemon is the judge.
		fs.put("/repo/a.ts", "theirs", { silent: true });
		store.edit("file:/repo/a.ts", "mine");
		expect(await store.save("file:/repo/a.ts")).toBe("conflict");
		expect(fs.files.get("/repo/a.ts")!.data).toBe("theirs");
		let tab = fileTab(store, "/repo/a.ts");
		expect(tab.disk).toMatchObject({ kind: "conflict", stat: { size: 6 } });

		// The node changes the file again: still the conflict, now with the newer content.
		fs.put("/repo/a.ts", "theirs!");
		await settle();
		expect(fileTab(store, "/repo/a.ts").disk).toMatchObject({ kind: "conflict", stat: { size: 7 }, text: "theirs!" });

		await store.compare("file:/repo/a.ts", true);
		tab = fileTab(store, "/repo/a.ts");
		expect(tab.compare).toBe(true);
		expect(tab.disk).toMatchObject({ kind: "conflict", text: "theirs!" });

		expect(await store.overwrite("file:/repo/a.ts")).toBe("saved");
		expect(fs.files.get("/repo/a.ts")!.data).toBe("mine");
		expect(fs.writes.at(-1)!.expected).toMatchObject({ size: 7 });
		tab = fileTab(store, "/repo/a.ts");
		expect(tab.disk).toBeUndefined();
		expect(tab.compare).toBe(false);

		fs.put("/repo/a.ts", "again", { silent: true });
		store.edit("file:/repo/a.ts", "mine 2");
		expect(await store.save("file:/repo/a.ts")).toBe("conflict");
		await store.reload("file:/repo/a.ts");
		tab = fileTab(store, "/repo/a.ts");
		expect(tab.body).toMatchObject({ text: "again", saved: "again" });
		expect(tab.disk).toBeUndefined();
		store.dispose();
	});

	it("keeps a deleted file's buffer and saves it as a new file", async () => {
		fs.put("/repo/a.ts", "one");
		const store = new EditorStore({ echoWindowMs: 50 });
		store.setFiles(files);
		await store.open("/repo/a.ts");
		await settle();
		store.edit("file:/repo/a.ts", "keep me");
		fs.remove("/repo/a.ts");
		await settle();
		expect(fileTab(store, "/repo/a.ts").disk).toEqual({ kind: "deleted" });
		expect(await store.save("file:/repo/a.ts")).toBe("saved");
		expect(fs.writes.at(-1)!.expected).toEqual({ absent: true });
		expect(fs.files.get("/repo/a.ts")!.data).toBe("keep me");
		await settle();
		expect(fileTab(store, "/repo/a.ts").watched).toBe(true);
		store.dispose();
	});

	it("checks open files again on a new channel", async () => {
		fs.put("/repo/a.ts", "one");
		const store = new EditorStore();
		store.setFiles(files);
		await store.open("/repo/a.ts");
		await settle();
		store.setFiles(undefined);
		// The fake node has one channel at a time: let the old one finish its unwatch. Its watches end with it.
		await settle();
		fs.watches.clear();
		fs.put("/repo/a.ts", "changed while away");
		const next = await connect();
		store.setFiles(next);
		await settle();
		expect(fileTab(store, "/repo/a.ts")).toMatchObject({ watched: true, body: { text: "changed while away" } });
		store.dispose();
	});

	it("diffs the working file against the index, and the index against HEAD", async () => {
		fs.put("/repo/a.ts", "working");
		fs.index.set("/repo/a.ts", "staged");
		fs.head.set("/repo/a.ts", "committed");
		fs.put("/repo/new.ts", "brand new");
		const store = new EditorStore();
		store.setFiles(files);
		await store.openDiff("/repo/a.ts", false);
		await store.openDiff("/repo/a.ts", true);
		await store.openDiff("/repo/new.ts", false);
		const diffs = store.getSnapshot().tabs.map((tab) => tab.kind === "diff" && [tab.labels.join(" → "), tab.original, tab.modified]);
		expect(diffs).toEqual([
			["Index → Working tree", "staged", "working"],
			["HEAD → Index", "committed", "staged"],
			["Index → Working tree", "", "brand new"],
		]);

		fs.unsupported.add("fs.gitShow");
		await store.refreshDiff("diff:worktree:/repo/a.ts");
		expect(store.tab("diff:worktree:/repo/a.ts")).toMatchObject({ status: "failed", error: expect.stringMatching(/update it/) });
		store.dispose();
	});
});

describe("the bridge's requests", () => {
	it("opens pane.open in a tab revealing its line, and pane.diff against the index or HEAD", async () => {
		fs.put("/repo/src/a.ts", "one\ntwo\nthree\n");
		fs.index.set("/repo/src/a.ts", "one\n");
		fs.head.set("/repo/src/a.ts", "zero\n");
		const store = new EditorStore();
		store.setFiles(files);
		// As the page wires it: every event from the node's channel goes through paneRequest.
		const requests: Promise<void>[] = [];
		channel.onEvent((event) => {
			const request = paneRequest(store, event);
			if (request) requests.push(request);
		});
		await node.send({ type: "pane.open", terminalId: "t1", path: "/repo/src/a.ts", line: 3, column: 2 });
		await settle();
		await Promise.all(requests);
		expect(store.getSnapshot().active).toBe("file:/repo/src/a.ts");
		const first = fileTab(store, "/repo/src/a.ts");
		expect(first.body).toMatchObject({ kind: "text", text: "one\ntwo\nthree\n" });
		expect(first.reveal).toMatchObject({ line: 3, column: 2 });

		// Asked again for the same place: the same tab, revealed again.
		await node.send({ type: "pane.open", terminalId: "t1", path: "/repo/src/a.ts", line: 3, column: 2 });
		await settle();
		expect(store.getSnapshot().tabs).toHaveLength(1);
		expect(fileTab(store, "/repo/src/a.ts").reveal!.serial).toBeGreaterThan(first.reveal!.serial);

		await node.send({ type: "pane.diff", terminalId: "t1", path: "/repo/src/a.ts", staged: false });
		await node.send({ type: "pane.diff", terminalId: "t1", path: "/repo/src/a.ts", staged: true });
		await settle();
		await Promise.all(requests);
		expect(store.getSnapshot().active).toBe("diff:staged:/repo/src/a.ts");
		expect(store.tab("diff:worktree:/repo/src/a.ts")).toMatchObject({ status: "ready", original: "one\n", modified: "one\ntwo\nthree\n" });
		expect(store.tab("diff:staged:/repo/src/a.ts")).toMatchObject({ status: "ready", original: "zero\n", modified: "one\n" });
		expect(node.received.filter((message) => message.type === "fs.gitShow").map((message) => "ref" in message && message.ref)).toEqual(["index", "HEAD", "index"]);
		store.dispose();
	});
});

describe("the tree's root", () => {
	const projects = [{ path: "/home/me/code" }, { path: "/home/me/code/pika" }, { path: "/srv/site" }];
	it("is the innermost project holding the pane's cwd, else the cwd, else the first project or home", () => {
		expect(rootFor(projects, "/home/me/code/pika/web/src", "/home/me")).toBe("/home/me/code/pika");
		expect(rootFor(projects, "/home/me/code/other", "/home/me")).toBe("/home/me/code");
		expect(rootFor(projects, "/home/me/code/pikachu", "/home/me")).toBe("/home/me/code");
		expect(rootFor(projects, "/tmp/scratch", "/home/me")).toBe("/tmp/scratch");
		expect(rootFor(projects, undefined, "/home/me")).toBe("/home/me/code");
		expect(rootFor([], undefined, "/home/me")).toBe("/home/me");
	});
});

describe("languageFor", () => {
	const languages = [
		{ id: "typescript", extensions: [".ts", ".tsx"] },
		{ id: "dockerfile", extensions: [".dockerfile"], filenames: ["Dockerfile"] },
		{ id: "markdown", extensions: [".md"] },
		{ id: "declarations", extensions: [".d.ts"] },
	];
	it("matches file names, then the longest extension, case-insensitively", () => {
		expect(languageFor("/r/src/App.TSX", languages)).toBe("typescript");
		expect(languageFor("/r/Dockerfile", languages)).toBe("dockerfile");
		expect(languageFor("/r/types.d.ts", languages)).toBe("declarations");
		expect(languageFor("/r/README.md", languages)).toBe("markdown");
		expect(languageFor("/r/.md", languages)).toBe("plaintext");
		expect(languageFor("/r/Makefile", languages)).toBe("plaintext");
	});
});

describe("the page's layout", () => {
	it("keeps widths within bounds and falls back to defaults", () => {
		const store = new Map<string, string>();
		const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
		expect(loadLayout(storage)).toEqual(LAYOUT_DEFAULTS);
		saveLayout({ ...LAYOUT_DEFAULTS, rail: 300, filesOpen: false }, storage);
		expect(loadLayout(storage)).toMatchObject({ rail: 300, filesOpen: false });
		store.set(LAYOUT_KEY, JSON.stringify({ rail: 5, files: 1e9, tree: "wide", hidden: true }));
		expect(loadLayout(storage)).toEqual({ ...LAYOUT_DEFAULTS, rail: 200, files: 1600, hidden: true });
		store.set(LAYOUT_KEY, "{not json");
		expect(loadLayout(storage)).toEqual(LAYOUT_DEFAULTS);
	});
});
