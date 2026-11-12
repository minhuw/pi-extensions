import { fireEvent, render } from "@testing-library/react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeChannel } from "../src/nodes/channel";
import { changeMode, ChangesStore, diffSpec, groupChanges } from "../src/nodes/changes";
import type { GitStatus, GitStatusEntry } from "../src/nodes/contract";
import { EditorStore, type DiffTab } from "../src/nodes/editor";
import { ChangesPanel, EditorTabBody, useChanges } from "../src/nodes/FilePanel";
import { NodeFiles } from "../src/nodes/files";
import { clientIdentity, MemoryKeyStore } from "../src/nodes/identity";
import { FakeFs } from "./support/fakeFs";
import { FakeNode, nodeCrypto, settle } from "./support/fakeNode";

// Monaco does not run in jsdom; the panel's diff tab gets a stand-in.
vi.mock("../src/nodes/CodeEditor", () => ({ default: () => <div data-stub-editor="" /> }));

beforeAll(() => {
	vi.stubGlobal("crypto", nodeCrypto);
});

let node: FakeNode;
let fs: FakeFs;
let files: NodeFiles;
const disposers: (() => void)[] = [];

async function connect(): Promise<NodeFiles> {
	const identity = await clientIdentity(new MemoryKeyStore());
	node.allowed.add(identity.fingerprint);
	const channel = new NodeChannel(node.route(), { identity, pinned: node.identity.fingerprint });
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
	vi.useRealTimers();
});

async function until(check: () => boolean, what: string): Promise<void> {
	for (let round = 0; round < 2_000; round++) {
		if (check()) return;
		await settle(1);
	}
	throw new Error(`timed out waiting for ${what}`);
}

const entry = (path: string, x: string, y: string, extra: Partial<GitStatusEntry> = {}): GitStatusEntry => ({ path, x, y, ...extra });
const status = (entries: GitStatusEntry[], extra: Partial<GitStatus> = {}): GitStatus => ({ top: "/repo", branch: "main", entries, truncated: false, ...extra });
const diffTab = (store: EditorStore, key: string): DiffTab => {
	const tab = store.tab(key);
	if (tab?.kind !== "diff") throw new Error(`no diff tab ${key}`);
	return tab;
};
const statusRequests = () => node.received.filter((message) => message.type === "git.status").length;

describe("grouping a status", () => {
	it("puts each path where git status shows it: conflicts alone, staged and changed both, untracked last", () => {
		const groups = groupChanges(
			status([
				entry("both.ts", "M", "M", { indexHash: "1" }),
				entry("src/new name.ts", "R", ".", { from: "old name.ts" }),
				entry("gone.ts", ".", "D"),
				entry("added.ts", "A", "."),
				entry("clash.ts", "U", "U", { conflict: true }),
				entry("vendor/lib", ".", "M", { submodule: true }),
				entry("fresh.ts", "?", "?"),
			]),
		);
		const summary = (group: keyof typeof groups) => groups[group].map((change) => `${change.code} ${change.path}${change.from ? ` <- ${change.from}` : ""}`);
		expect(summary("conflicts")).toEqual(["U /repo/clash.ts"]);
		expect(summary("staged")).toEqual(["M /repo/both.ts", "R /repo/src/new name.ts <- /repo/old name.ts", "A /repo/added.ts"]);
		expect(summary("unstaged")).toEqual(["M /repo/both.ts", "D /repo/gone.ts", "M /repo/vendor/lib"]);
		expect(summary("untracked")).toEqual(["? /repo/fresh.ts"]);
		expect(groups.unstaged[2]).toMatchObject({ submodule: true, relative: "vendor/lib" });
		expect(groups.staged.map(changeMode)).toEqual(["staged", "staged", "staged"]);
		expect(changeMode(groups.unstaged[0]!)).toBe("worktree");
		expect(changeMode(groups.untracked[0]!)).toBe("untracked");
		expect(changeMode(groups.conflicts[0]!)).toBeUndefined();
	});

	it("joins paths onto a top level at the root of the file system", () => {
		expect(groupChanges(status([entry("etc/x", ".", "M")], { top: "/" })).unstaged[0]!.path).toBe("/etc/x");
	});
});

describe("choosing a diff's sides", () => {
	it("compares HEAD (at a rename's source) with the index, the index with the disk, and nothing with a new file", () => {
		expect(diffSpec("staged", "/repo/new.ts", "/repo/old.ts")).toEqual({
			original: { ref: "HEAD", path: "/repo/old.ts" },
			modified: { ref: "index", path: "/repo/new.ts" },
			labels: ["HEAD", "Index"],
		});
		expect(diffSpec("staged", "/repo/a.ts").original).toEqual({ ref: "HEAD", path: "/repo/a.ts" });
		expect(diffSpec("worktree", "/repo/a.ts")).toEqual({
			original: { ref: "index", path: "/repo/a.ts" },
			modified: { ref: "working", path: "/repo/a.ts" },
			labels: ["Index", "Working tree"],
		});
		expect(diffSpec("untracked", "/repo/a.ts")).toEqual({ original: { ref: "none" }, modified: { ref: "working", path: "/repo/a.ts" }, labels: ["Nothing", "Working tree"] });
	});

	it("reads each side from where the spec says, and shows a new file as all added", async () => {
		fs.put("/repo/new.ts", "fresh\n");
		fs.head.set("/repo/old.ts", "before\n");
		fs.index.set("/repo/new.ts", "after\n");
		const store = new EditorStore();
		store.setFiles(files);
		await store.openDiff("/repo/new.ts", "untracked");
		expect(diffTab(store, "diff:untracked:/repo/new.ts")).toMatchObject({ status: "ready", original: "", modified: "fresh\n", labels: ["Nothing", "Working tree"] });
		// A new file asks git for nothing.
		expect(node.received.filter((message) => message.type === "fs.gitShow")).toHaveLength(0);

		await store.openDiff("/repo/new.ts", "staged", "/repo/old.ts");
		expect(diffTab(store, "diff:staged:/repo/new.ts")).toMatchObject({ status: "ready", original: "before\n", modified: "after\n", from: "/repo/old.ts" });
		// A staged deletion: the index has no such file.
		fs.head.set("/repo/deleted.ts", "was here\n");
		await store.openDiff("/repo/deleted.ts", "staged");
		expect(diffTab(store, "diff:staged:/repo/deleted.ts")).toMatchObject({ status: "ready", original: "was here\n", modified: "" });
		store.dispose();
	});

	it("names a binary or too large side instead of diffing it", async () => {
		fs.put("/repo/logo.png", "x", { binary: true });
		fs.index.set("/repo/logo.png", "y");
		fs.index.set("/repo/big.txt", "z".repeat(512 * 1024 + 1));
		fs.put("/repo/big.txt", "small now");
		const store = new EditorStore();
		store.setFiles(files);
		await store.openDiff("/repo/logo.png", "worktree");
		expect(diffTab(store, "diff:worktree:/repo/logo.png")).toMatchObject({ status: "ready", blocked: { side: "modified", reason: "binary" }, original: "", modified: "" });
		fs.binaryRefs.add("index:/repo/logo.png");
		await store.refreshDiff("diff:worktree:/repo/logo.png");
		expect(diffTab(store, "diff:worktree:/repo/logo.png").blocked).toEqual({ side: "original", reason: "binary" });
		await store.openDiff("/repo/big.txt", "worktree");
		expect(diffTab(store, "diff:worktree:/repo/big.txt")).toMatchObject({ blocked: { side: "original", reason: "too_large" } });

		// Once the file is text on both sides again, the diff shows.
		fs.binaryRefs.clear();
		fs.index.set("/repo/big.txt", "small");
		await store.refreshDiff("diff:worktree:/repo/big.txt");
		const fixed = diffTab(store, "diff:worktree:/repo/big.txt");
		expect(fixed.blocked).toBeUndefined();
		expect(fixed).toMatchObject({ original: "small", modified: "small now" });
		store.dispose();
	});
});

describe("live diffs", () => {
	it("follow the file on disk through its watch, saves included, and share the watch with its file tab", async () => {
		fs.put("/repo/a.ts", "one\n");
		fs.index.set("/repo/a.ts", "zero\n");
		const store = new EditorStore({ echoWindowMs: 50 });
		store.setFiles(files);
		await store.openDiff("/repo/a.ts", "worktree");
		await until(() => fs.watches.size === 1, "the diff's watch");

		fs.put("/repo/a.ts", "two\n");
		await until(() => diffTab(store, "diff:worktree:/repo/a.ts").modified === "two\n", "the diff to follow the change");

		// The file tab and the diff watch the path once; the diff refreshes on the tab's own save.
		await store.open("/repo/a.ts");
		expect(fs.watches.size).toBe(1);
		store.edit("file:/repo/a.ts", "three\n");
		expect(await store.save("file:/repo/a.ts")).toBe("saved");
		await until(() => diffTab(store, "diff:worktree:/repo/a.ts").modified === "three\n", "the diff to follow the save");

		// Closing one keeps the watch for the other; closing both ends it.
		store.close("file:/repo/a.ts");
		await settle();
		expect(fs.watches.size).toBe(1);
		store.close("diff:worktree:/repo/a.ts");
		await until(() => fs.watches.size === 0, "the watch to end");
		store.dispose();
	});

	it("refresh the diffs a new status names, which staging changes without touching the file", async () => {
		fs.put("/repo/a.ts", "work\n");
		fs.index.set("/repo/a.ts", "old\n");
		fs.head.set("/repo/a.ts", "old\n");
		fs.status = status([entry("a.ts", ".", "M", { indexHash: "h1" })]);
		const store = new EditorStore();
		store.setFiles(files);
		await store.openDiff("/repo/a.ts", "worktree");
		await store.openDiff("/repo/a.ts", "staged");
		const changes = new ChangesStore(files, "/repo", { pollMs: 10, onChanged: (paths) => store.refreshDiffs(paths) });
		disposers.push(() => changes.dispose());
		changes.setActive(true);
		await until(() => changes.getSnapshot().status === "ready", "the first status");

		// `git add a.ts`: the index changes, the file does not.
		fs.index.set("/repo/a.ts", "work\n");
		fs.status = status([entry("a.ts", "M", ".", { indexHash: "h2" })]);
		await until(() => diffTab(store, "diff:staged:/repo/a.ts").modified === "work\n", "the staged diff to refresh");
		expect(diffTab(store, "diff:worktree:/repo/a.ts")).toMatchObject({ original: "work\n", modified: "work\n" });
		store.dispose();
	});

	it("keep the newest refresh when two overlap", async () => {
		fs.put("/repo/a.ts", "first\n");
		const store = new EditorStore();
		store.setFiles(files);
		await store.openDiff("/repo/a.ts", "untracked");
		const older = store.refreshDiff("diff:untracked:/repo/a.ts");
		fs.put("/repo/a.ts", "second\n", { silent: true });
		const newer = store.refreshDiff("diff:untracked:/repo/a.ts");
		await Promise.all([older, newer]);
		expect(diffTab(store, "diff:untracked:/repo/a.ts").modified).toBe("second\n");
		store.dispose();
	});
});

describe("the changes store", () => {
	it("polls only while active, one request at a time, and reports which paths changed", async () => {
		fs.status = status([entry("a.ts", ".", "M", { indexHash: "1" }), entry("b.ts", "?", "?")]);
		const changed: string[][] = [];
		const changes = new ChangesStore(files, "/repo/src", { pollMs: 20, onChanged: (paths) => changed.push(paths) });
		disposers.push(() => changes.dispose());
		await settle();
		expect(statusRequests()).toBe(0);

		changes.setActive(true);
		await until(() => changes.getSnapshot().status === "ready", "the first status");
		expect(node.received.find((message) => message.type === "git.status")).toMatchObject({ root: "/repo/src" });
		const ready = changes.getSnapshot();
		expect(ready).toMatchObject({ status: "ready", top: "/repo", branch: "main", count: 2, truncated: false });

		fs.status = status([entry("a.ts", "M", ".", { indexHash: "2" }), entry("c.ts", "?", "?")]);
		await until(() => changed.length > 0, "a change report");
		expect(changed[0]!.sort()).toEqual(["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"]);

		changes.setActive(false);
		await settle(5);
		const stopped = statusRequests();
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(statusRequests()).toBe(stopped);

		// Asked three times at once: one request, and one more for the asks made while it was in flight.
		void changes.refresh();
		void changes.refresh();
		await changes.refresh();
		await until(() => statusRequests() === stopped + 2, "the second request");
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(statusRequests()).toBe(stopped + 2);
	});

	it("says when the root is in no work tree, or the node has no git.status, and stops polling the latter", async () => {
		const changes = new ChangesStore(files, "/plain", { pollMs: 10 });
		disposers.push(() => changes.dispose());
		changes.setActive(true);
		await until(() => changes.getSnapshot().status === "not_repo", "not_repo");

		fs.unsupported.add("git.status");
		const old = new ChangesStore(files, "/repo", { pollMs: 10 });
		disposers.push(() => old.dispose());
		old.setActive(true);
		await until(() => old.getSnapshot().status === "unsupported", "unsupported");
		changes.setActive(false);
		await settle(5);
		const asked = statusRequests();
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(statusRequests()).toBe(asked);
	});
});

/** The Changes panel and the tab it opens, wired as Deck wires them (its sidebar and a tab group's body). */
function ChangesHarness({ store, onStore }: { store: EditorStore; onStore?: (changes: ChangesStore) => void }) {
	const changes = useMemo(() => new ChangesStore(files, "/repo", { onChanged: (paths) => store.refreshDiffs(paths) }), [store]);
	useEffect(() => {
		changes.setActive(true);
		onStore?.(changes);
		return () => changes.dispose();
	}, [changes, onStore]);
	const view = useChanges(changes);
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const active = snapshot.tabs.find((tab) => tab.key === snapshot.active);
	return (
		<>
			<ChangesPanel
				connected
				root="/repo"
				view={view}
				home="/home/me"
				{...(active ? { activeKey: active.key } : {})}
				onOpen={(change) => {
					const mode = changeMode(change);
					if (change.submodule) return;
					if (mode) void store.openDiff(change.path, mode, change.from);
					else void store.open(change.path);
				}}
				onRefresh={() => void changes.refresh()}
			/>
			{active && (
				<EditorTabBody
					node="node-1"
					nodeName="node01"
					home="/home/me"
					store={store}
					tab={active}
					keys={snapshot.tabs.map((tab) => tab.key)}
					theme="light"
					diffInline={false}
					onDiffInline={() => {}}
				/>
			)}
		</>
	);
}

describe("the Changes list", () => {
	const panel = (store: EditorStore, onStore?: (changes: ChangesStore) => void) => render(<ChangesHarness store={store} {...(onStore ? { onStore } : {})} />);

	it("lists the groups, and opens a diff, a new file, or a conflicted file from them", async () => {
		fs.put("/repo/src/a.ts", "work\n");
		fs.index.set("/repo/src/a.ts", "base\n");
		fs.put("/repo/notes.md", "new\n");
		fs.put("/repo/clash.ts", "<<<<<<<\n");
		fs.status = status([
			entry("src/a.ts", ".", "M", { indexHash: "1" }),
			entry("clash.ts", "U", "U", { conflict: true }),
			entry("vendor/lib", "M", ".", { submodule: true, indexHash: "2" }),
			entry("notes.md", "?", "?"),
		]);
		const store = new EditorStore();
		store.setFiles(files);
		let changes: ChangesStore | undefined;
		const { container } = panel(store, (made) => (changes = made));
		await until(() => container.querySelector("[data-change]") !== null, "the list");
		expect([...container.querySelectorAll("[data-change-group]")].map((group) => group.getAttribute("data-change-group"))).toEqual([
			"conflicts",
			"staged",
			"unstaged",
			"untracked",
		]);
		expect(changes!.getSnapshot()).toMatchObject({ status: "ready", count: 4 });
		expect(container.querySelector("[data-changes-branch]")!.textContent).toContain("main");
		expect((container.querySelector("[data-change='/repo/vendor/lib']") as HTMLButtonElement).disabled).toBe(true);

		fireEvent.click(container.querySelector("[data-change-group='unstaged'] [data-change='/repo/src/a.ts']")!);
		await until(() => store.tab("diff:worktree:/repo/src/a.ts")?.kind === "diff" && diffTab(store, "diff:worktree:/repo/src/a.ts").status === "ready", "the diff");
		await until(() => container.querySelector("[data-diff-view]") !== null, "the diff view");
		expect(container.querySelector("[data-diff-labels]")!.textContent).toBe("Index → Working tree");
		expect(container.querySelector("[data-change='/repo/src/a.ts']")!.getAttribute("aria-current")).toBe("true");

		fireEvent.click(container.querySelector("[data-change='/repo/notes.md']")!);
		await until(() => store.getSnapshot().active === "diff:untracked:/repo/notes.md", "the new file's diff");
		await until(() => container.querySelector("[data-diff-labels]")?.textContent === "Untracked: every line is new", "its header");

		fireEvent.click(container.querySelector("[data-change='/repo/clash.ts']")!);
		await until(() => store.getSnapshot().active === "file:/repo/clash.ts", "the conflicted file");
		store.dispose();
	});

	it("says why there is no list, and shows a blocked diff's reason", async () => {
		const store = new EditorStore();
		store.setFiles(files);
		const { container, unmount } = panel(store);
		await until(() => container.querySelector("[data-changes-state='not_repo']") !== null, "not a repository");
		unmount();

		fs.status = status([]);
		const clean = panel(store);
		await until(() => clean.container.querySelector("[data-changes-state='clean']") !== null, "no changes");
		clean.unmount();

		fs.status = status([entry("logo.png", ".", "M", { indexHash: "1" })]);
		fs.put("/repo/logo.png", "x", { binary: true });
		fs.index.set("/repo/logo.png", "y");
		const binary = panel(store);
		await until(() => binary.container.querySelector("[data-change]") !== null, "the list");
		fireEvent.click(binary.container.querySelector("[data-change]")!);
		await until(() => binary.container.querySelector("[data-diff-blocked='binary']") !== null, "the binary message");
		expect(binary.container.querySelector("[data-diff-blocked]")!.textContent).toMatch(/logo\.png is binary in the working tree/);
		expect(binary.container.querySelector("[data-stub-editor]")).toBeNull();
		binary.unmount();

		// A pure rename: the same content under a new name, said as much rather than "no changes".
		fs.status = status([entry("src/new.ts", "R", ".", { from: "old.ts", indexHash: "1" })]);
		fs.head.set("/repo/old.ts", "same\n");
		fs.index.set("/repo/src/new.ts", "same\n");
		const renamed = panel(store);
		await until(() => renamed.container.querySelector("[data-change]") !== null, "the list");
		fireEvent.click(renamed.container.querySelector("[data-change]")!);
		await until(() => renamed.container.querySelector("[data-diff-empty]") !== null, "the rename message");
		expect(renamed.container.querySelector("[data-diff-empty]")!.textContent).toBe("Renamed from /repo/old.ts, with the same content.");
		expect(renamed.container.querySelector("[data-diff-labels]")!.textContent).toBe("HEAD → Index, renamed from /repo/old.ts");
		store.dispose();
	});
});
