import { fireEvent, render, screen } from "@testing-library/react";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { countedTitle, paneCounts, PaneAlerts } from "../src/nodes/alerts";
import { NodeChannel, NodeRequestError } from "../src/nodes/channel";
import { paneCwd, type NodeView } from "../src/nodes/client";
import { fromBase64Url, LIMITS, type DirEntry, type PaneView, type Requests, type TerminalInfo } from "../src/nodes/contract";
import { NodeFiles } from "../src/nodes/files";
import { fuzzyScore, rankPaths } from "../src/nodes/fuzzy";
import { clientIdentity, MemoryKeyStore } from "../src/nodes/identity";
import { isFindKey, isQuickOpenKey } from "../src/nodes/keys";
import { cellRange, findPaths, PathChecker, resolvePath } from "../src/nodes/links";
import { clipboardImage, pasteText, runsPi, shellQuote } from "../src/nodes/paste";
import { QuickOpen } from "../src/nodes/QuickOpen";
import { Sha256 } from "../src/nodes/sha256";
import { TERMINAL_OPTIONS } from "../src/nodes/TerminalView";
import { UploadCancelled, uploadFiles, uploadName, type UploadRequest } from "../src/nodes/upload";
import { FakeFs } from "./support/fakeFs";
import { FakeNode, nodeCrypto, settle } from "./support/fakeNode";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("Sha256", () => {
	it("matches node's SHA-256 for any length and any way of splitting the input", () => {
		const data = new Uint8Array(1_000);
		for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
		for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 999, 1_000]) {
			const input = data.subarray(0, length);
			expect(new Sha256().update(input).hex(), `length ${length}`).toBe(sha(input));
			for (const step of [1, 3, 64, 100]) {
				const hash = new Sha256();
				for (let at = 0; at < length; at += step) hash.update(input.subarray(at, at + step));
				expect(hash.hex(), `length ${length} in steps of ${step}`).toBe(sha(input));
			}
		}
	});

	it("takes no input after its digest", () => {
		const hash = new Sha256();
		hash.hex();
		expect(() => hash.update(new Uint8Array(1))).toThrow();
		expect(() => hash.hex()).toThrow();
	});
});

/** The daemon's upload rules (NODE.md, "Upload") in memory: ordered offsets, the announced size, and the hash. */
function fakeUploads() {
	const calls: { type: string; params: Record<string, unknown> }[] = [];
	const uploads = new Map<string, { name: string; size: number; data: Uint8Array }>();
	const finished = new Map<string, Uint8Array>();
	let ids = 0;
	let onChunk: (offset: number) => void = () => {};
	const request = (async (type: keyof Requests, params: Record<string, unknown>) => {
		calls.push({ type, params });
		switch (type) {
			case "fs.uploadStart": {
				const upload = `u${++ids}`;
				uploads.set(upload, { name: params.name as string, size: params.size as number, data: new Uint8Array(0) });
				return { upload, path: `/home/me/.pika-node/uploads/2026-11-12/${params.name as string}` };
			}
			case "fs.uploadChunk": {
				const entry = uploads.get(params.upload as string)!;
				if (params.offset !== entry.data.length) throw new NodeRequestError({ code: "invalid", message: "out of order" });
				const bytes = fromBase64Url(params.data as string)!;
				expect(bytes.length).toBeLessThanOrEqual(LIMITS.maxUploadChunkBytes);
				const joined = new Uint8Array(entry.data.length + bytes.length);
				joined.set(entry.data);
				joined.set(bytes, entry.data.length);
				entry.data = joined;
				if (entry.data.length > entry.size) throw new NodeRequestError({ code: "too_large", message: "over the size" });
				onChunk(params.offset as number);
				return { received: entry.data.length };
			}
			case "fs.uploadFinish": {
				const entry = uploads.get(params.upload as string)!;
				const bytes = entry.data;
				uploads.delete(params.upload as string);
				if (sha(bytes) !== params.hash) throw new NodeRequestError({ code: "conflict", message: "hash mismatch" });
				const path = `/home/me/.pika-node/uploads/2026-11-12/${entry.name}`;
				finished.set(path, bytes);
				return { path, stat: { size: bytes.length, mtimeMs: 1, hash: params.hash as string } };
			}
			case "fs.uploadCancel":
				uploads.delete(params.upload as string);
				return {};
			default:
				throw new Error(`unexpected ${type}`);
		}
	}) as unknown as UploadRequest;
	return { request, calls, uploads, finished, setOnChunk: (listener: (offset: number) => void) => (onChunk = listener) };
}

const blobOf = (length: number, seed = 1) => {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) bytes[i] = (i * seed + 13) & 0xff;
	return { blob: new Blob([bytes]), bytes };
};

describe("uploadFiles", () => {
	it("sends each file in ordered chunks with its SHA-256, and reports progress", async () => {
		const fake = fakeUploads();
		const first = blobOf(2_500, 3);
		const second = blobOf(10, 5);
		const progress: { index: number; sent: number }[] = [];
		const done = await uploadFiles(fake.request, [{ blob: first.blob, name: "a.bin" }, { blob: second.blob, name: "b.bin" }], {
			chunkBytes: 1_000,
			onProgress: ({ index, sent }) => progress.push({ index, sent }),
		});
		expect(done.map((item) => item.path)).toEqual(["/home/me/.pika-node/uploads/2026-11-12/a.bin", "/home/me/.pika-node/uploads/2026-11-12/b.bin"]);
		expect([...fake.finished.values()]).toEqual([first.bytes, second.bytes]);
		const chunks = fake.calls.filter((call) => call.type === "fs.uploadChunk").map((call) => call.params.offset);
		expect(chunks).toEqual([0, 1_000, 2_000, 0]);
		expect(fake.calls.find((call) => call.type === "fs.uploadFinish")!.params.hash).toBe(sha(first.bytes));
		expect(progress.at(-1)).toEqual({ index: 1, sent: 2_510 });
		expect(progress.map((item) => item.sent)).toEqual([0, 1_000, 2_000, 2_500, 2_500, 2_510]);
	});

	it("never sends a chunk over the node's limit", async () => {
		const fake = fakeUploads();
		const { blob } = blobOf(LIMITS.maxUploadChunkBytes + 1);
		await uploadFiles(fake.request, [{ blob, name: "big.bin" }], { chunkBytes: LIMITS.maxUploadChunkBytes * 4 });
		expect(fake.calls.filter((call) => call.type === "fs.uploadChunk").map((call) => call.params.offset)).toEqual([0, LIMITS.maxUploadChunkBytes]);
	});

	it("uploads an empty file with no chunks", async () => {
		const fake = fakeUploads();
		await uploadFiles(fake.request, [{ blob: new Blob([]), name: "empty" }]);
		expect(fake.calls.map((call) => call.type)).toEqual(["fs.uploadStart", "fs.uploadFinish"]);
		expect(fake.calls[1]!.params.hash).toBe(sha(""));
	});

	it("cancels between chunks: the node deletes the file in flight, and finished ones stay", async () => {
		const fake = fakeUploads();
		const abort = new AbortController();
		fake.setOnChunk((offset) => {
			if (offset === 100) abort.abort();
		});
		const items = [
			{ blob: blobOf(50).blob, name: "first.bin" },
			{ blob: blobOf(500).blob, name: "second.bin" },
		];
		await expect(uploadFiles(fake.request, items, { chunkBytes: 100, signal: abort.signal })).rejects.toBeInstanceOf(UploadCancelled);
		expect(fake.calls.map((call) => call.type)).toEqual([
			"fs.uploadStart",
			"fs.uploadChunk",
			"fs.uploadFinish",
			"fs.uploadStart",
			"fs.uploadChunk",
			"fs.uploadChunk",
			"fs.uploadCancel",
		]);
		expect(fake.uploads.size).toBe(0);
		expect([...fake.finished.keys()]).toEqual(["/home/me/.pika-node/uploads/2026-11-12/first.bin"]);
	});

	it("does not start once cancelled, and refuses files over the upload limit before sending", async () => {
		const fake = fakeUploads();
		const abort = new AbortController();
		abort.abort();
		await expect(uploadFiles(fake.request, [{ blob: blobOf(1).blob, name: "x" }], { signal: abort.signal })).rejects.toBeInstanceOf(UploadCancelled);
		const huge = { size: LIMITS.maxUploadBytes + 1, slice: () => new Blob([]) } as unknown as Blob;
		await expect(uploadFiles(fake.request, [{ blob: huge, name: "huge.iso" }])).rejects.toThrow(/256 MiB/);
		expect(fake.calls).toEqual([]);
	});

	it("leaves a refused hash to the node, and cancels after any other failure", async () => {
		const fake = fakeUploads();
		const wrong: UploadRequest = (type, params) =>
			(type === "fs.uploadFinish" ? fake.request(type, { ...params, hash: "0".repeat(64) } as never) : fake.request(type, params)) as never;
		await expect(uploadFiles(wrong, [{ blob: blobOf(10).blob, name: "x" }])).rejects.toMatchObject({ code: "conflict" });
		expect(fake.calls.map((call) => call.type)).not.toContain("fs.uploadCancel");

		const failing = fakeUploads();
		const broken: UploadRequest = (type, params) =>
			(type === "fs.uploadChunk" ? Promise.reject(new NodeRequestError({ code: "io", message: "ENOSPC" })) : failing.request(type, params)) as never;
		await expect(uploadFiles(broken, [{ blob: blobOf(10).blob, name: "x" }])).rejects.toMatchObject({ code: "io" });
		expect(failing.calls.map((call) => call.type)).toEqual(["fs.uploadStart", "fs.uploadCancel"]);
	});
});

describe("uploadName", () => {
	it("makes a base name the node accepts", () => {
		expect(uploadName("report.pdf")).toBe("report.pdf");
		expect(uploadName("a/b\x1b[31m.txt")).toBe("a_b_[31m.txt");
		expect(uploadName("..")).toBe("upload");
		expect(uploadName("  ")).toBe("upload");
		const long = uploadName(`${"x".repeat(300)}.tar.gz`);
		expect(long).toHaveLength(255);
		expect(long.endsWith(".gz")).toBe(true);
	});
});

describe("pasteText", () => {
	it("quotes a path for a shell only when it must", () => {
		expect(shellQuote("/home/me/a.png")).toBe("/home/me/a.png");
		expect(shellQuote("/home/me/Screen Shot.png")).toBe("'/home/me/Screen Shot.png'");
		expect(shellQuote("/tmp/it's $HOME")).toBe(`'/tmp/it'\\''s $HOME'`);
	});

	it("frames the paste only when the pane turned bracketed paste on", () => {
		const paths = ["/u/a b.png", "/u/c.txt"];
		expect(pasteText(paths, { bracketed: true, pi: false })).toBe("\x1b[200~'/u/a b.png' /u/c.txt \x1b[201~");
		expect(pasteText(paths, { bracketed: false, pi: false })).toBe("'/u/a b.png' /u/c.txt ");
		// pi takes bare paths, one per line, as its own clipboard file paste inserts them.
		expect(pasteText(paths, { bracketed: true, pi: true })).toBe("\x1b[200~/u/a b.png\n/u/c.txt \x1b[201~");
		expect(pasteText([], { bracketed: true, pi: true })).toBe("");
	});

	it("refuses a path that could end the paste early", () => {
		expect(() => pasteText(["/u/x\x1b[201~; rm -rf ~"], { bracketed: true, pi: true })).toThrow(/control/);
	});

	it("knows pi from its program status or its bridge", () => {
		const info = { exited: undefined } as Pick<TerminalInfo, "status" | "exited">;
		const status = (view: Partial<PaneView>): PaneView => ({ state: "idle", bridgeConnected: false, unread: false, ...view });
		expect(runsPi(info)).toBe(false);
		expect(runsPi({ status: status({ program: { state: "idle", app: "pi", at: 1 } }) })).toBe(true);
		expect(runsPi({ status: status({ program: { state: "idle", app: "vim", at: 1 } }) })).toBe(false);
		expect(runsPi({ status: status({ bridgeConnected: true }) })).toBe(true);
		expect(runsPi({ status: status({ bridgeConnected: true }), exited: { code: 0, signal: null } })).toBe(false);
	});
});

describe("clipboardImage", () => {
	const transfer = (items: { kind: string; type: string; file?: File }[]) =>
		({ items: items.map((item) => ({ kind: item.kind, type: item.type, getAsFile: () => item.file ?? null })) }) as unknown as DataTransfer;

	it("takes the first image pi's read tool reads, named by its type", () => {
		const png = new File([new Uint8Array([0x89, 0x50])], "image.png", { type: "image/png" });
		const when = new Date("2026-11-12T09:08:07.123Z");
		const found = clipboardImage(transfer([{ kind: "string", type: "text/html" }, { kind: "file", type: "image/png", file: png }]), when);
		expect(found).toEqual({ blob: png, name: "pasted-2026-11-12-09-08-07.png" });
		expect(clipboardImage(transfer([{ kind: "file", type: "image/jpeg", file: png }]), when)?.name).toMatch(/\.jpg$/);
		expect(clipboardImage(transfer([{ kind: "file", type: "image/svg+xml", file: png }]))).toBeUndefined();
		expect(clipboardImage(transfer([{ kind: "file", type: "application/pdf", file: png }]))).toBeUndefined();
		expect(clipboardImage(null)).toBeUndefined();
	});
});

describe("findPaths", () => {
	const paths = (line: string) => findPaths(line).map(({ path, line: at, column }) => [path, at, column].filter((part) => part !== undefined).join(":"));

	it("finds paths with grep's and compilers' line and column", () => {
		expect(paths("src/a.ts:12:const x = 1")).toEqual(["src/a.ts:12", "x", "1"]);
		expect(paths("error at /home/me/b.rs:3:7: expected ;")).toEqual(["error", "at", "/home/me/b.rs:3:7", "expected"]);
		expect(paths("see ~/notes.md, then ./run.sh.")).toEqual(["see", "~/notes.md", "then", "./run.sh"]);
	});

	it("reads ls output, skipping flags, URLs, and marks", () => {
		expect(paths("package.json  src/  bin*  link@")).toEqual(["package.json", "src/", "bin", "link"]);
		expect(paths("ls -la https://example.com/a.ts .. ~")).toEqual(["ls", "~"]);
		expect(paths("(a.ts) 'b.ts' [c.ts]")).toEqual(["a.ts", "b.ts", "c.ts"]);
		expect(paths("--- +++ :: ")).toEqual([]);
	});

	it("gives each match's range in the line, the location included", () => {
		const line = "M  src/a.ts:12:3 done";
		const [match] = findPaths(line).filter((item) => item.path === "src/a.ts");
		expect(line.slice(match!.start, match!.end)).toBe("src/a.ts:12:3");
		expect(findPaths("a ".repeat(100), 5)).toHaveLength(5);
	});

	it("maps a match to buffer cells, wide characters taking two", () => {
		// "文 a.ts": 文 fills cells 0–1, the space cell 2, a.ts cells 3–6.
		const line = { text: "文 a.ts", cells: [0, 2, 3, 4, 5, 6], widths: [2, 1, 1, 1, 1, 1] };
		const [, match] = findPaths(line.text);
		expect(cellRange(line, match!.start, match!.end)).toEqual({ first: 4, last: 7 });
		expect(cellRange(line, 0, 1)).toEqual({ first: 1, last: 2 });
	});
});

describe("resolvePath", () => {
	it("resolves against the pane's cwd and the node's home", () => {
		expect(resolvePath("src/a.ts", "/home/me/code", "/home/me")).toBe("/home/me/code/src/a.ts");
		expect(resolvePath("../b/./c.ts", "/home/me/code", "/home/me")).toBe("/home/me/b/c.ts");
		expect(resolvePath("~/x.md", "/tmp", "/home/me")).toBe("/home/me/x.md");
		expect(resolvePath("~", "/tmp", "/home/me")).toBe("/home/me");
		expect(resolvePath("/etc//hosts", "/tmp", "/home/me")).toBe("/etc/hosts");
		expect(resolvePath("../../..", "/a", "/home/me")).toBe("/");
		expect(resolvePath("~root/.profile", "/tmp", "/home/me")).toBeUndefined();
	});
});

describe("PathChecker", () => {
	it("lists each directory once per window, and answers what it holds", async () => {
		let now = 0;
		const listed: string[] = [];
		const listing: Record<string, DirEntry[]> = {
			"/p": [
				{ name: "a.ts", kind: "file", size: 1, mtimeMs: 1 },
				{ name: "src", kind: "dir", size: 1, mtimeMs: 1 },
			],
		};
		const checker = new PathChecker(
			async (dir) => {
				listed.push(dir);
				const entries = listing[dir];
				if (!entries) throw new NodeRequestError({ code: "not_found", message: dir });
				return entries;
			},
			{ ttlMs: 1_000, now: () => now },
		);
		expect(await Promise.all([checker.kind("/p/a.ts"), checker.kind("/p/src"), checker.kind("/p/nope")])).toEqual(["file", "dir", undefined]);
		expect(await checker.kind("/missing/x")).toBeUndefined();
		expect(listed).toEqual(["/p", "/missing"]);
		now = 2_000;
		await checker.kind("/p/a.ts");
		expect(listed).toEqual(["/p", "/missing", "/p"]);
		expect(await checker.kind("/")).toBe("dir");
	});
});

describe("quick open ranking", () => {
	const PATHS = [
		"docs/api/parser.md",
		"src/nodes/paste.ts",
		"src/pages/Nodes.tsx",
		"src/nodes/TerminalView.tsx",
		"tests/node-paste.test.ts",
		"src/parse/a/s/t/e.ts",
		"README.md",
	];

	it("needs the query's characters in order, ignoring case and spaces", () => {
		expect(fuzzyScore("pst", "src/nodes/paste.ts")).toBeDefined();
		expect(fuzzyScore("tsp", "src/nodes/paste.ts")).toBeUndefined();
		expect(fuzzyScore("NODES tsx", "src/pages/Nodes.tsx")).toBeDefined();
		expect(fuzzyScore("", "x")).toBe(0);
	});

	it("ranks a base-name match first, then segment starts over scattered letters", () => {
		expect(rankPaths("paste", PATHS).map((item) => item.path)).toEqual(["src/nodes/paste.ts", "tests/node-paste.test.ts", "src/parse/a/s/t/e.ts"]);
		expect(rankPaths("tv", PATHS)[0]!.path).toBe("src/nodes/TerminalView.tsx");
		expect(rankPaths("readme", PATHS)[0]!.path).toBe("README.md");
		expect(rankPaths("nodes", PATHS)[0]!.path).toBe("src/pages/Nodes.tsx");
	});

	it("keeps the listing's order for an empty query, and cuts at the limit", () => {
		expect(rankPaths("", PATHS, 2).map((item) => item.path)).toEqual(PATHS.slice(0, 2));
		expect(rankPaths("s", PATHS, 3)).toHaveLength(3);
	});
});

const node = (id: string, terminals: TerminalInfo[]): NodeView =>
	({ info: { id, name: id, online: true }, link: { kind: "idle" }, terminals, epoch: 1 }) as NodeView;
const term = (terminalId: string, status?: Partial<PaneView>, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
	terminalId,
	title: `title ${terminalId}`,
	cwd: "/home/me",
	cols: 80,
	rows: 24,
	pid: 1,
	createdAt: 1,
	argv: [],
	...(status ? { status: { state: "idle", bridgeConnected: false, unread: false, ...status } } : {}),
	...extra,
});

describe("PaneAlerts", () => {
	it("alerts when a pane starts waiting or finishes, never for the state it first had", () => {
		const alerts = new PaneAlerts();
		const away = { node: "n1", terminalId: "t9", visible: true };
		expect(alerts.update([node("n1", [term("t1", { state: "waiting" }), term("t2", { state: "busy" })])], away)).toEqual([]);
		const waiting = { state: "waiting" as const, program: { state: "blocked" as const, app: "pi", kind: "permission" as const, message: "Allow \x1b[31mwrite?", at: 2 } };
		const fired = alerts.update([node("n1", [term("t1", { state: "waiting" }), term("t2", waiting)])], away);
		expect(fired).toEqual([{ node: "n1", terminalId: "t2", kind: "waiting", title: "title t2", body: "Allow write?" }]);
		expect(alerts.update([node("n1", [term("t1", { state: "waiting" }), term("t2", { state: "idle", unread: true })])], away)).toEqual([
			{ node: "n1", terminalId: "t2", kind: "done", title: "title t2", body: "Finished on n1" },
		]);
		// No change, no alert.
		expect(alerts.update([node("n1", [term("t1", { state: "waiting" }), term("t2", { state: "idle", unread: true })])], away)).toEqual([]);
	});

	it("stays quiet for the pane on screen in a visible page, and alerts for it in a hidden one", () => {
		const alerts = new PaneAlerts();
		alerts.update([node("n1", [term("t1", { state: "busy" })])], { visible: true });
		expect(alerts.update([node("n1", [term("t1", { state: "waiting" })])], { node: "n1", terminalId: "t1", visible: true })).toEqual([]);
		alerts.update([node("n1", [term("t1", { state: "busy" })])], { visible: true });
		expect(alerts.update([node("n1", [term("t1", { state: "waiting" })])], { node: "n1", terminalId: "t1", visible: false })).toHaveLength(1);
	});

	it("remembers panes across a reconnect, and ignores exited ones", () => {
		const alerts = new PaneAlerts();
		alerts.update([node("n1", [term("t1", { state: "busy" })])], { visible: false });
		alerts.update([node("n1", [])], { visible: false });
		expect(alerts.update([node("n1", [term("t1", { state: "idle", unread: true })])], { visible: false })).toHaveLength(1);
		alerts.update([node("n1", [term("t2", { state: "busy" })])], { visible: false });
		expect(alerts.update([node("n1", [term("t2", { state: "waiting" }, { exited: { code: 0, signal: null } })])], { visible: false })).toEqual([]);
	});

	it("counts waiting and finished panes for the tab's title", () => {
		const nodes = [node("n1", [term("t1", { state: "waiting" }), term("t2", { state: "idle", unread: true })]), node("n2", [term("t3", { state: "waiting" }), term("t4")])];
		expect(paneCounts(nodes)).toEqual({ waiting: 2, done: 1 });
		expect(countedTitle("pika", { waiting: 2, done: 1 })).toBe("(2 waiting, 1 done) pika");
		expect(countedTitle("pika", { waiting: 0, done: 3 })).toBe("(3 done) pika");
		expect(countedTitle("pika", { waiting: 0, done: 0 })).toBe("pika");
	});
});

describe("shortcuts", () => {
	const key = (letter: string, mods: Partial<KeyboardEvent> = {}) => ({ key: letter, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

	it("use Cmd on macOS and Ctrl+Shift elsewhere, leaving readline's Ctrl-F and Ctrl-P alone", () => {
		expect(isFindKey(key("f", { metaKey: true }), true)).toBe(true);
		expect(isFindKey(key("f", { ctrlKey: true }), true)).toBe(false);
		expect(isFindKey(key("F", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
		expect(isFindKey(key("f", { ctrlKey: true }), false)).toBe(false);
		expect(isQuickOpenKey(key("p", { metaKey: true }), true)).toBe(true);
		expect(isQuickOpenKey(key("p", { metaKey: true, shiftKey: true }), true)).toBe(false);
		expect(isQuickOpenKey(key("p", { ctrlKey: true }), false)).toBe(false);
		expect(isQuickOpenKey(key("P", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
	});
});

describe("QuickOpen", () => {
	beforeAll(() => {
		vi.stubGlobal("crypto", nodeCrypto);
	});

	async function connected(): Promise<{ files: NodeFiles; fs: FakeFs; node: FakeNode }> {
		const fakeNode = await FakeNode.create("node-1");
		const fs = new FakeFs(fakeNode);
		const identity = await clientIdentity(new MemoryKeyStore());
		fakeNode.allowed.add(identity.fingerprint);
		const channel = new NodeChannel(fakeNode.route(), { identity, pinned: fakeNode.identity.fingerprint });
		await channel.start();
		await settle();
		return { files: new NodeFiles(channel), fs, node: fakeNode };
	}

	it("lists the worktree holding the pane with fs.list and opens the best match", async () => {
		const { files, fs, node: fakeNode } = await connected();
		fs.put("/home/me/pika/src/nodes/paste.ts", "x", { silent: true });
		fs.put("/home/me/pika/src/pages/Nodes.tsx", "x", { silent: true });
		fs.put("/home/me/other/paste.ts", "x", { silent: true });
		const onPick = vi.fn();
		// The node has no term.cwd here, so the pane's starting cwd picks the worktree.
		render(<QuickOpen files={files} terminal={term("t1", undefined, { cwd: "/home/me/pika/src" })} roots={["/home/me/other", "/home/me/pika"]} home="/home/me" onPick={onPick} onClose={() => {}} />);
		await screen.findByText("Nodes.tsx");
		expect(fakeNode.received.find((message) => message.type === "fs.list")).toMatchObject({ root: "/home/me/pika" });
		const input = screen.getByRole("combobox");
		fireEvent.change(input, { target: { value: "nodes" } });
		expect(screen.getAllByRole("option")[0]!.dataset.path).toBe("src/pages/Nodes.tsx");
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onPick).toHaveBeenCalledWith("/home/me/pika/src/nodes/paste.ts");
	});

	it("says so when the node has no fs.list", async () => {
		const { files, fs } = await connected();
		fs.unsupported.add("fs.list");
		render(<QuickOpen files={files} home="/home/me" onPick={() => {}} onClose={() => {}} />);
		expect(await screen.findByText(/update it to use quick open/)).toBeTruthy();
	});
});

describe("terminal search", () => {
	it("highlights every match and counts them with the terminal's options", async () => {
		const term = new Terminal({ ...TERMINAL_OPTIONS, cols: 40, rows: 5 });
		term.open(document.body.appendChild(document.createElement("div")));
		const search = new SearchAddon();
		term.loadAddon(search);
		const results: { resultIndex: number; resultCount: number }[] = [];
		search.onDidChangeResults((event) => results.push(event));
		await new Promise<void>((resolve) => term.write("paste one\r\nno match\r\npaste two", resolve));
		const decorations = { matchOverviewRuler: "#000", activeMatchColorOverviewRuler: "#111" };
		expect(search.findNext("paste", { decorations })).toBe(true);
		expect(results.at(-1)).toEqual({ resultIndex: 0, resultCount: 2 });
		expect(search.findNext("paste", { decorations })).toBe(true);
		expect(results.at(-1)).toEqual({ resultIndex: 1, resultCount: 2 });
		term.dispose();
	});

	it("needs the proposed API for its highlights (the control)", async () => {
		const term = new Terminal({ ...TERMINAL_OPTIONS, allowProposedApi: false, cols: 40, rows: 5 });
		term.open(document.body.appendChild(document.createElement("div")));
		const search = new SearchAddon();
		term.loadAddon(search);
		await new Promise<void>((resolve) => term.write("paste", resolve));
		expect(() => search.findNext("paste", { decorations: { matchOverviewRuler: "#000", activeMatchColorOverviewRuler: "#111" } })).toThrow(/allowProposedApi/);
		term.dispose();
	});
});

describe("paneCwd", () => {
	it("asks the shell's directory, unless pi's bridge names its session's", async () => {
		const asked: string[] = [];
		const request = (async (type: string, params: { terminalId: string }) => {
			asked.push(`${type} ${params.terminalId}`);
			return { cwd: "/srv/after-cd" };
		}) as never;
		expect(await paneCwd(request, term("t1"))).toBe("/srv/after-cd");
		const session = { state: "idle" as const, activities: [], activityCount: 0, session: { id: "s", cwd: "/home/me/pi-here" }, updatedAt: 1 };
		expect(await paneCwd(request, term("t2", { bridge: session, bridgeConnected: true }))).toBe("/home/me/pi-here");
		expect(await paneCwd(request, term("t3", undefined, { exited: { code: 0, signal: null } }))).toBe("/home/me");
		expect(asked).toEqual(["term.cwd t1"]);
		const old = (async () => {
			throw new NodeRequestError({ code: "unsupported", message: "unknown request term.cwd" });
		}) as never;
		expect(await paneCwd(old, term("t4"))).toBe("/home/me");
	});
});
