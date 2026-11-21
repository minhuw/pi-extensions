/**
 * Regression tests for Monaco model lifecycle, render-phase purity, per-(node, key) view state scoping,
 * and multi-node `beforeunload` dirty checks across `CodeEditor`, `FilePanel`, and `Deck`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "../src/lib/theme";
import { NodesClient } from "../src/nodes/client";
import type { Body, ClientMessage, TerminalInfo } from "../src/nodes/contract";
import { EditorStore, type FileTab } from "../src/nodes/editor";
import { clientIdentity, MemoryKeyStore } from "../src/nodes/identity";
import type { WebSocketLike } from "../src/nodes/socket";
import { fakeKey, gitCheckout } from "./support/checkouts";
import { FakeFs } from "./support/fakeFs";
import { FakeNode, nodeCrypto, settle } from "./support/fakeNode";
import { renderWithApi } from "./support/render";

interface FakeModel {
	id: number;
	value: string;
	language: string;
	disposed: boolean;
	listeners: Set<() => void>;
	getValue: () => string;
	setValue: (next: string) => void;
	getValueLength: () => number;
	getLanguageId: () => string;
	getFullModelRange: () => { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
	pushEditOperations: ReturnType<typeof vi.fn>;
	onDidChangeContent: (listener: () => void) => { dispose: () => void };
	dispose: ReturnType<typeof vi.fn>;
	/** Test helper: simulates user typing into the model. */
	simulateEdit: (next: string) => void;
}

interface FakeEditor {
	model: FakeModel | null;
	viewState: unknown;
	contentListeners: Set<() => void>;
	setModel: ReturnType<typeof vi.fn>;
	getModel: () => FakeModel | null;
	saveViewState: ReturnType<typeof vi.fn>;
	restoreViewState: ReturnType<typeof vi.fn>;
	addCommand: ReturnType<typeof vi.fn>;
	onDidChangeModelContent: (listener: () => void) => { dispose: () => void };
	setPosition: ReturnType<typeof vi.fn>;
	revealPositionInCenter: ReturnType<typeof vi.fn>;
	focus: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
}

interface FakeDiffEditor {
	models: { original: FakeModel; modified: FakeModel } | null;
	modified: FakeEditor;
	setModel: ReturnType<typeof vi.fn>;
	getModifiedEditor: () => FakeEditor;
	updateOptions: ReturnType<typeof vi.fn>;
	onDidUpdateDiff: (listener: () => void) => { dispose: () => void };
	getLineChanges: () => unknown[];
	goToDiff: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
}

const monacoHarness = vi.hoisted(() => {
	let nextModelId = 0;
	const events: string[] = [];
	const createdModels: FakeModel[] = [];
	const createdEditors: FakeEditor[] = [];
	const createdDiffEditors: FakeDiffEditor[] = [];

	const makeEditor = (): FakeEditor => {
		let currentModel: FakeModel | null = null;
		let modelSub: { dispose: () => void } | null = null;
		const contentListeners = new Set<() => void>();
		const editor: FakeEditor = {
			get model() {
				return currentModel;
			},
			set model(value) {
				currentModel = value;
			},
			viewState: null,
			contentListeners,
			setModel: vi.fn((next: FakeModel | null) => {
				events.push(`editor.setModel(${next ? `m${next.id}` : "null"})`);
				modelSub?.dispose();
				modelSub = null;
				currentModel = next;
				if (next) {
					modelSub = next.onDidChangeContent(() => {
						for (const listener of [...contentListeners]) listener();
					});
				}
			}),
			getModel: () => currentModel,
			saveViewState: vi.fn(() => editor.viewState),
			restoreViewState: vi.fn((state: unknown) => {
				editor.viewState = state;
			}),
			addCommand: vi.fn(),
			onDidChangeModelContent: (listener: () => void) => {
				contentListeners.add(listener);
				return { dispose: () => contentListeners.delete(listener) };
			},
			setPosition: vi.fn(),
			revealPositionInCenter: vi.fn(),
			focus: vi.fn(),
			dispose: vi.fn(() => {
				events.push("editor.dispose()");
				modelSub?.dispose();
				modelSub = null;
				contentListeners.clear();
			}),
		};
		createdEditors.push(editor);
		return editor;
	};

	const createModel = vi.fn((value: string, language = "plaintext"): FakeModel => {
		const id = ++nextModelId;
		events.push(`createModel(m${id})`);
		const listeners = new Set<() => void>();
		const model: FakeModel = {
			id,
			value,
			language,
			disposed: false,
			listeners,
			getValue: () => model.value,
			setValue: (next: string) => {
				model.value = next;
				for (const listener of [...listeners]) listener();
			},
			getValueLength: () => model.value.length,
			getLanguageId: () => model.language,
			getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: model.value.length + 1 }),
			pushEditOperations: vi.fn((_sel: unknown, edits: { text: string }[]) => {
				if (edits[0]) model.value = edits[0].text;
				for (const listener of [...listeners]) listener();
				return null;
			}),
			onDidChangeContent: (listener: () => void) => {
				listeners.add(listener);
				return { dispose: () => listeners.delete(listener) };
			},
			dispose: vi.fn(() => {
				events.push(`model.dispose(m${id})`);
				model.disposed = true;
				listeners.clear();
			}),
			simulateEdit: (next: string) => {
				model.value = next;
				for (const listener of [...listeners]) listener();
			},
		};
		createdModels.push(model);
		return model;
	});

	const create = vi.fn(() => makeEditor());

	const createDiffEditor = vi.fn((): FakeDiffEditor => {
		const modified = makeEditor();
		const diff: FakeDiffEditor = {
			models: null,
			modified,
			setModel: vi.fn((pair: { original: FakeModel; modified: FakeModel } | null) => {
				events.push(`diff.setModel(${pair ? `m${pair.original.id},m${pair.modified.id}` : "null"})`);
				diff.models = pair;
			}),
			getModifiedEditor: () => modified,
			updateOptions: vi.fn(),
			onDidUpdateDiff: () => ({ dispose: () => {} }),
			getLineChanges: () => [],
			goToDiff: vi.fn(),
			dispose: vi.fn(() => {
				events.push("diff.dispose()");
			}),
		};
		createdDiffEditors.push(diff);
		return diff;
	});

	const reset = () => {
		nextModelId = 0;
		events.length = 0;
		createdModels.length = 0;
		createdEditors.length = 0;
		createdDiffEditors.length = 0;
		createModel.mockClear();
		create.mockClear();
		createDiffEditor.mockClear();
	};

	const monaco = {
		KeyMod: { CtrlCmd: 2048 },
		KeyCode: { KeyS: 49 },
		languages: {
			getLanguages: () => [
				{ id: "typescript", extensions: [".ts", ".tsx"] },
				{ id: "markdown", extensions: [".md"] },
			],
		},
		editor: {
			setTheme: vi.fn(),
			createModel,
			create,
			createDiffEditor,
		},
	};

	return {
		monaco,
		themeName: (theme: Theme) => (theme === "dark" ? "pika-dark" : "pika-light"),
		events,
		createdModels,
		createdEditors,
		createdDiffEditors,
		reset,
	};
});

vi.mock("../src/nodes/monaco/setup", () => ({
	monaco: monacoHarness.monaco,
	themeName: monacoHarness.themeName,
}));

import CodeEditor, { pruneModels } from "../src/nodes/CodeEditor";
import { EditorTabBody, pruneCodeEditorModels } from "../src/nodes/FilePanel";
import { DeckPage, hasDirtyEditorTab, NodesClientFactory } from "../src/pages/Deck";

class StubResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

beforeAll(() => {
	vi.stubGlobal("crypto", nodeCrypto);
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	Element.prototype.scrollIntoView = () => {};
});

function fileTab(path: string, text: string, extra: Partial<FileTab> = {}): FileTab {
	const name = path.slice(path.lastIndexOf("/") + 1) || path;
	return {
		kind: "file",
		key: `file:${path}`,
		path,
		name,
		body: { kind: "text", text, saved: text, stat: { size: text.length, mtimeMs: 1, hash: "h1" } },
		saving: false,
		compare: false,
		watched: true,
		...extra,
	};
}

beforeEach(() => {
	monacoHarness.reset();
});

afterEach(() => {
	cleanup();
	pruneModels("node-1", new Set());
	pruneModels("node-2", new Set());
	monacoHarness.reset();
});

describe("CodeEditor invariants", () => {
	it("does not create Monaco models synchronously during the React render phase (CodeView and CompareView)", () => {
		const observed: number[] = [];
		function RenderProbe() {
			observed.push(monacoHarness.monaco.editor.createModel.mock.calls.length);
			return null;
		}

		const tab = fileTab("/repo/a.ts", "const a = 1;\n");
		const view = render(
			<>
				<CodeEditor scope="node-1" tab={tab} open={[tab.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />
				<RenderProbe />
			</>,
		);
		expect(observed).toEqual([0]);
		expect(monacoHarness.monaco.editor.createModel).toHaveBeenCalledTimes(1);

		// Switching to CompareView must also defer model creation to effects rather than render.
		const compareTab = fileTab("/repo/compare.ts", "mine\n", {
			compare: true,
			disk: { kind: "changed", stat: { size: 7, mtimeMs: 2, hash: "h2" }, text: "theirs\n" },
		});
		const callsBeforeCompare = monacoHarness.monaco.editor.createModel.mock.calls.length;
		observed.length = 0;
		view.rerender(
			<>
				<CodeEditor scope="node-1" tab={compareTab} open={[compareTab.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />
				<RenderProbe />
			</>,
		);
		expect(observed).toEqual([callsBeforeCompare]);
		// CompareView creates both the buffer model and the read-only disk original model inside useEffect.
		expect(monacoHarness.monaco.editor.createModel).toHaveBeenCalledTimes(callsBeforeCompare + 2);

		view.unmount();
	});

	it("prunes leaked ITextModels and saved view states when closing tabs and when unmounting the last tab", () => {
		const tabA = fileTab("/repo/a.ts", "alpha\n");
		const tabB = fileTab("/repo/b.ts", "beta\n");

		const view = render(<CodeEditor scope="node-1" tab={tabA} open={[tabA.key, tabB.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		const editor = monacoHarness.createdEditors[0]!;
		const modelA = monacoHarness.createdModels[0]!;
		const viewStateA = { scrollTop: 320, cursor: { lineNumber: 18, column: 4 } };
		editor.viewState = viewStateA;

		// Switch to tabB while tabA stays open: tabA's model stays alive and its view state is saved.
		view.rerender(<CodeEditor scope="node-1" tab={tabB} open={[tabA.key, tabB.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		const modelB = monacoHarness.createdModels[1]!;
		expect(modelA.disposed).toBe(false);
		expect(modelB.disposed).toBe(false);

		// Close tabA while tabB stays open: tabA's model is disposed and its saved view state is dropped.
		view.rerender(<CodeEditor scope="node-1" tab={tabB} open={[tabB.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		expect(modelA.disposed).toBe(true);
		expect(modelB.disposed).toBe(false);

		// Re-opening tabA creates a brand new model and does NOT restore the deleted view state.
		editor.restoreViewState.mockClear();
		view.rerender(<CodeEditor scope="node-1" tab={tabA} open={[tabA.key, tabB.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		const modelA2 = monacoHarness.createdModels[2]!;
		expect(modelA2).not.toBe(modelA);
		expect(editor.restoreViewState).not.toHaveBeenCalled();

		// Closing the last editor (unmounting) detaches before disposing and prunes all models in the scope.
		monacoHarness.events.length = 0;
		view.unmount();
		expect(modelA2.disposed).toBe(true);
		expect(modelB.disposed).toBe(true);
		expect(monacoHarness.events.indexOf("editor.setModel(null)")).toBeGreaterThanOrEqual(0);
		expect(monacoHarness.events.indexOf("editor.setModel(null)")).toBeLessThan(monacoHarness.events.indexOf(`model.dispose(m${modelA2.id})`));
	});

	it("keeps split-group models alive until the last editor in a scope unmounts, and detaches CompareView before disposal", () => {
		const tabA = fileTab("/repo/a.ts", "alpha\n");
		const tabB = fileTab("/repo/b.ts", "beta\n");

		const view = render(
			<>
				<CodeEditor scope="node-1" tab={tabA} open={[tabA.key, tabB.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />
				<CodeEditor scope="node-1" tab={tabB} open={[tabA.key, tabB.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />
			</>,
		);
		const [modelA, modelB] = monacoHarness.createdModels;
		expect(modelA!.disposed).toBe(false);
		expect(modelB!.disposed).toBe(false);

		// Closing one split group prunes only the closed tab, leaving the remaining split's model intact.
		view.rerender(<CodeEditor scope="node-1" tab={tabB} open={[tabB.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		expect(modelA!.disposed).toBe(true);
		expect(modelB!.disposed).toBe(false);

		// Switching the last remaining tab to CompareView and unmounting detaches diff before disposing both models.
		const compareB = fileTab("/repo/b.ts", "beta\n", {
			compare: true,
			disk: { kind: "changed", stat: { size: 5, mtimeMs: 2, hash: "h2" }, text: "disk\n" },
		});
		view.rerender(<CodeEditor scope="node-1" tab={compareB} open={[compareB.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		const originalModel = monacoHarness.createdModels[2]!;
		monacoHarness.events.length = 0;

		view.unmount();
		expect(originalModel.disposed).toBe(true);
		expect(modelB!.disposed).toBe(true);
		const detachIdx = monacoHarness.events.indexOf("diff.setModel(null)");
		expect(detachIdx).toBeGreaterThanOrEqual(0);
		expect(detachIdx).toBeLessThan(monacoHarness.events.indexOf(`model.dispose(m${modelB!.id})`));
		expect(detachIdx).toBeLessThan(monacoHarness.events.indexOf(`model.dispose(m${originalModel.id})`));
	});

	it("prunes closed text models from FilePanel even when the active tab switches to a non-text body", async () => {
		const store = new EditorStore();
		const textTab = fileTab("/repo/readme.md", "# hi\n");
		const binaryTab: FileTab = {
			...fileTab("/repo/logo.png", ""),
			body: { kind: "binary", size: 64 },
		};

		const view = render(
			<EditorTabBody
				node="node-1"
				nodeName="node01"
				home="/home/me"
				store={store}
				tab={textTab}
				keys={[textTab.key, binaryTab.key]}
				theme="dark"
				diffInline={false}
				onDiffInline={vi.fn()}
			/>,
		);
		await waitFor(() => expect(monacoHarness.createdModels.length).toBe(1));
		const textModel = monacoHarness.createdModels[0]!;
		expect(textModel.disposed).toBe(false);

		// Switching to a binary tab unmounts CodeEditor; pruning removes the closed text tab's model cleanly.
		view.rerender(
			<EditorTabBody
				node="node-1"
				nodeName="node01"
				home="/home/me"
				store={store}
				tab={binaryTab}
				keys={[binaryTab.key]}
				theme="dark"
				diffInline={false}
				onDiffInline={vi.fn()}
			/>,
		);
		expect(textModel.disposed).toBe(true);

		// Once the lazy CodeEditor chunk has loaded, pruneCodeEditorModels disposes closed models even without unmounting.
		const tab1 = fileTab("/repo/one.ts", "one\n");
		const tab2 = fileTab("/repo/two.ts", "two\n");
		const direct = render(<CodeEditor scope="node-1" tab={tab1} open={[tab1.key, tab2.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		const model1 = monacoHarness.createdModels.at(-1)!;
		direct.rerender(<CodeEditor scope="node-1" tab={tab2} open={[tab1.key, tab2.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		expect(model1.disposed).toBe(false);
		pruneCodeEditorModels("node-1", new Set([tab2.key]));
		expect(model1.disposed).toBe(true);

		direct.unmount();
		view.unmount();
		store.dispose();
	});

	it("scopes Monaco models and saved view states per (node, key) without colliding across scopes", () => {
		const readmeNode1 = fileTab("/repo/README.md", "# node-1\n");
		const readmeNode2 = fileTab("/repo/README.md", "# node-2\n");
		const viewState1 = { scrollTop: 500, cursor: { lineNumber: 42, column: 1 } };
		const viewState2 = { scrollTop: 90, cursor: { lineNumber: 7, column: 3 } };

		// Single CodeEditor switching scopes for the exact same file path (as Deck does when switching nodes).
		const view = render(<CodeEditor scope="node-1" tab={readmeNode1} open={[readmeNode1.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		const editor = monacoHarness.createdEditors[0]!;
		const model1 = monacoHarness.createdModels[0]!;
		expect(model1.value).toBe("# node-1\n");
		editor.viewState = viewState1;

		// Switch to node-2 with the identical path/key: must create a separate model and must NOT clobber node-2 with node-1's view state.
		editor.restoreViewState.mockClear();
		view.rerender(<CodeEditor scope="node-2" tab={readmeNode2} open={[readmeNode2.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		expect(monacoHarness.createdModels).toHaveLength(2);
		const model2 = monacoHarness.createdModels[1]!;
		expect(model2).not.toBe(model1);
		expect(model2.value).toBe("# node-2\n");
		expect(editor.getModel()).toBe(model2);
		expect(editor.restoreViewState).not.toHaveBeenCalled();
		editor.viewState = viewState2;

		// Switch back to node-1: reuses model1 and restores node-1's view state.
		editor.restoreViewState.mockClear();
		view.rerender(<CodeEditor scope="node-1" tab={readmeNode1} open={[readmeNode1.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		expect(monacoHarness.createdModels).toHaveLength(2);
		expect(editor.getModel()).toBe(model1);
		expect(editor.restoreViewState).toHaveBeenCalledWith(viewState1);

		// Switch back to node-2: reuses model2 and restores node-2's view state.
		editor.restoreViewState.mockClear();
		view.rerender(<CodeEditor scope="node-2" tab={readmeNode2} open={[readmeNode2.key]} theme="dark" onChange={vi.fn()} onSave={vi.fn()} />);
		expect(monacoHarness.createdModels).toHaveLength(2);
		expect(editor.getModel()).toBe(model2);
		expect(editor.restoreViewState).toHaveBeenCalledWith(viewState2);

		// Unmounting cleans up both scopes' models.
		view.unmount();
		expect(model1.disposed).toBe(true);
		expect(model2.disposed).toBe(true);
	});
});

/** Multi-node in-memory browser WebSocket for Deck integration tests. */
function multiNodeSocket(nodes: readonly { node: FakeNode; name: string }[]): () => WebSocketLike {
	return () => {
		const routes = new Map<string, ReturnType<FakeNode["route"]>>();
		const byId = new Map(nodes.map((entry) => [entry.node.id, entry.node]));
		let channels = 0;
		const socket: WebSocketLike = {
			readyState: 0,
			onopen: null,
			onmessage: null,
			onclose: null,
			onerror: null,
			send(text: string) {
				const frame = JSON.parse(text) as { type: string; ref?: string; node?: string; channel?: string; body?: Body; code?: string };
				if (frame.type === "open") {
					const target = byId.get(frame.node ?? "");
					if (!target) return;
					const channel = `ch${++channels}`;
					const route = target.route(channel);
					route.onFrame = (body) => emit({ type: "frame", channel, body });
					route.onClose = (code) => emit({ type: "close", channel, code });
					routes.set(channel, route);
					emit({ type: "opened", ref: frame.ref, channel, node: target.id });
				} else if (frame.type === "frame") routes.get(frame.channel!)?.send(frame.body!);
				else if (frame.type === "close") routes.get(frame.channel!)?.close(frame.code!);
			},
			close() {
				(socket as { readyState: number }).readyState = 3;
			},
		} as WebSocketLike;
		const emit = (frame: object) => {
			const data = JSON.stringify(frame);
			queueMicrotask(() => socket.onmessage?.(new MessageEvent("message", { data })));
		};
		queueMicrotask(() => {
			(socket as { readyState: number }).readyState = 1;
			socket.onopen?.(new Event("open"));
			emit({ type: "welcome", serverVersion: "0.9.0", limits: { heartbeatSeconds: 20, maxFrameBytes: 2 << 20, maxChannels: 16 } });
			emit({ type: "nodes", items: nodes.map((entry) => ({ id: entry.node.id, name: entry.name, online: true })) });
		});
		return socket;
	};
}

function deckFetch(): typeof fetch {
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://pika.test");
		const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
		if (url.pathname === "/api/health") return json({ ok: true, version: "0.9.0", basePath: "/", features: ["nodes"] });
		if (url.pathname === "/api/v1/deck/project-keys") return json({ keys: (body as { items: Parameters<typeof fakeKey>[0][] }).items.map(fakeKey) });
		if (url.pathname === "/api/v1/deck/projects") return json({ projects: [] });
		return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
	}) as typeof fetch;
}

const HOME = "/home/me";
const shell = (terminalId: string, cwd: string): TerminalInfo => ({
	terminalId,
	title: terminalId,
	cwd,
	cols: 80,
	rows: 24,
	pid: 1,
	createdAt: 1,
	argv: ["/bin/zsh", "-l"],
});

function fireBeforeUnload(): boolean {
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

describe("Deck multi-node beforeunload dirty check", () => {
	it("checks dirty tabs across every open EditorStore via hasDirtyEditorTab", async () => {
		const node1 = await FakeNode.create("node-1");
		const node2 = await FakeNode.create("node-2");
		const fs1 = new FakeFs(node1);
		const fs2 = new FakeFs(node2);
		fs1.put("/repo/a.ts", "clean-1\n");
		fs2.put("/repo/a.ts", "clean-2\n");

		const keyStore = new MemoryKeyStore();
		const identity = await clientIdentity(keyStore);
		for (const node of [node1, node2]) {
			node.allowed.add(identity.fingerprint);
			await keyStore.pin({ node: node.id, fingerprint: node.identity.fingerprint, publicKey: "k", name: node.id, pinnedAt: 1 });
		}

		const client = new NodesClient({
			socketUrl: "ws://pika.test/api/v1/node/connect",
			store: keyStore,
			label: "test",
			socket: {
				create: multiNodeSocket([
					{ node: node1, name: "alpha" },
					{ node: node2, name: "beta" },
				]),
			},
		});
		client.start();
		await waitFor(() => {
			expect(client.files("node-1")).toBeDefined();
			expect(client.files("node-2")).toBeDefined();
		});

		const store1 = new EditorStore();
		const store2 = new EditorStore();
		store1.setFiles(client.files("node-1"));
		store2.setFiles(client.files("node-2"));

		await store1.open("/repo/a.ts");
		await store2.open("/repo/a.ts");
		expect(store1.tab("file:/repo/a.ts")).toMatchObject({ body: { kind: "text", text: "clean-1\n" } });
		expect(hasDirtyEditorTab([store1, store2])).toBe(false);

		store1.edit("file:/repo/a.ts", "dirty-1\n");
		expect(hasDirtyEditorTab([store1, store2])).toBe(true);

		store1.edit("file:/repo/a.ts", "clean-1\n");
		expect(hasDirtyEditorTab([store1, store2])).toBe(false);

		store1.dispose();
		store2.dispose();
		client.dispose();
	});

	it("warns on beforeunload when a non-active background node has an unsaved tab, and stays silent when all nodes are clean", async () => {
		const node1 = await FakeNode.create("node-1");
		const node2 = await FakeNode.create("node-2");
		const fs1 = new FakeFs(node1);
		const fs2 = new FakeFs(node2);
		const repo1 = gitCheckout("c1", `${HOME}/repo-one`);
		const repo2 = gitCheckout("c2", `${HOME}/repo-two`);
		fs1.put(`${HOME}/repo-one/notes.md`, "original\n");
		fs2.put(`${HOME}/repo-two/notes.md`, "clean\n");
		fs1.status = { top: repo1.path, branch: "main", entries: [], truncated: false };
		fs2.status = { top: repo2.path, branch: "main", entries: [], truncated: false };

		const wireNode = (node: FakeNode, repo: ReturnType<typeof gitCheckout>, termId: string) => {
			const welcome = node.welcome.bind(node);
			node.welcome = () => ({ ...welcome(), home: HOME, capabilities: [...welcome().capabilities, "checkouts"] });
			const terms = [{ ...shell(termId, repo.path), checkoutId: repo.id, worktreePath: repo.path }];
			const fsHandler = node.onMessage;
			node.onMessage = (message: ClientMessage, fake: FakeNode) => {
				if ("id" in message) {
					if (message.type === "term.list") {
						void fake.send({ type: "reply", id: message.id, result: { terminals: terms } } as never);
						return;
					}
					if (message.type === "checkouts.list") {
						void fake.send({ type: "reply", id: message.id, result: { checkouts: [repo], truncated: false } } as never);
						return;
					}
				}
				fsHandler(message, fake);
			};
		};
		wireNode(node1, repo1, "t1");
		wireNode(node2, repo2, "t2");

		const keyStore = new MemoryKeyStore();
		const identity = await clientIdentity(keyStore);
		for (const node of [node1, node2]) {
			node.allowed.add(identity.fingerprint);
			await keyStore.pin({ node: node.id, fingerprint: node.identity.fingerprint, publicKey: "k", name: node.id, pinnedAt: 1 });
		}

		let client: NodesClient | undefined;
		const factory = (options: ConstructorParameters<typeof NodesClient>[0]) => {
			client = new NodesClient({
				...options,
				store: keyStore,
				socket: {
					create: multiNodeSocket([
						{ node: node1, name: "alpha" },
						{ node: node2, name: "beta" },
					]),
				},
			});
			return client;
		};

		const view = renderWithApi(
			<NodesClientFactory.Provider value={factory}>
				<Routes>
					<Route path="/deck/:node?/:terminal?" element={<DeckPage />} />
				</Routes>
			</NodesClientFactory.Provider>,
			deckFetch(),
			"/deck/node-1",
		);

		await waitFor(() => {
			expect(client?.files("node-1")).toBeDefined();
			expect(client?.files("node-2")).toBeDefined();
		});
		await act(() => settle(40));

		// Open a file on node-1 via the bridge pane.open event.
		await act(async () => {
			await node1.send({ type: "pane.open", terminalId: "t1", path: `${HOME}/repo-one/notes.md` });
			await settle(40);
		});
		await waitFor(() => expect(monacoHarness.createdModels).toHaveLength(1));
		const node1Model = monacoHarness.createdModels[0]!;
		expect(node1Model.value).toBe("original\n");

		// Clean across all nodes: beforeunload must NOT prevent default.
		expect(fireBeforeUnload()).toBe(false);

		// Make node-1's file dirty through Monaco's content change event.
		await act(async () => {
			node1Model.simulateEdit("unsaved edit\n");
		});
		await waitFor(() => expect(fireBeforeUnload()).toBe(true));

		// Switch Deck to node-2 (which has no dirty tabs) by clicking node-2's agent row in Projects view.
		fireEvent.click(screen.getByRole("button", { name: "Projects" }));
		await waitFor(() => expect(document.querySelector("[data-agent-row='t2']")).not.toBeNull());
		fireEvent.click(document.querySelector("[data-agent-row='t2']")!);
		await waitFor(() => expect(document.querySelector("[data-code-editor]")).toBeNull());

		// Node-1 is now in the background, yet its unsaved tab MUST still trigger beforeunload!
		expect(fireBeforeUnload()).toBe(true);

		// Switch back to node-1 and revert the edit so all nodes are clean again.
		fireEvent.click(document.querySelector("[data-agent-row='t1']")!);
		await waitFor(() => expect(document.querySelector("[data-tab-id='file:/home/me/repo-one/notes.md']")).not.toBeNull());
		fireEvent.click(document.querySelector("[data-tab-id='file:/home/me/repo-one/notes.md'] [role='tab']")!);
		await waitFor(() => expect(document.querySelector("[data-code-editor]")).not.toBeNull());
		const activeModel = monacoHarness.createdEditors.at(-1)?.getModel();
		expect(activeModel).toBeDefined();
		expect(activeModel!.value).toBe("unsaved edit\n");
		await act(async () => {
			activeModel!.simulateEdit("original\n");
		});
		await waitFor(() => expect(fireBeforeUnload()).toBe(false));

		view.unmount();
		expect(monacoHarness.createdModels.every((model) => model.disposed)).toBe(true);
		client?.dispose();
	});
});
