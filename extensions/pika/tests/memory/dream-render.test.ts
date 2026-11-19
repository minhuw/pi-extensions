import { afterEach, beforeEach, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { currentDream } from "../../memory/dream/index.ts";
import { FakePika } from "./support/pika-server.ts";
import { batch, type FakeChild, fakeSpawner, RecordingUI, resetDreams, serveDreams } from "./support/dream.ts";
import { type Harness, note, PROJECT_SCOPE, setCredentials, startSession, USER_SCOPE, Workspace } from "./support/runtime.ts";

const OSC52 = "\x1b]52;c;SGVsbG8=\x07";
const CSI_RED = "\x1b[31m";
const CSI_RESET = "\x1b[0m";
const CSI_CLEAR = "\x1b[2J";
const DIRTY = `${OSC52}${CSI_RED}danger${CSI_RESET}${CSI_CLEAR}`;
const SOURCES = [{ sessionId: "s-past-1", seq: 7 }];

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const styledTheme = { fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;
const lines = (component: { render(width: number): string[] }) => component.render(500).map((line) => line.trimEnd()).join("\n");

let workspace: Workspace;
let pika: FakePika;
let ui: RecordingUI;
let spawner: ReturnType<typeof fakeSpawner>;
let h: Harness;

beforeEach(async () => {
	workspace = await Workspace.create();
	pika = await new FakePika().start();
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [], index: "" } });
	serveDreams(pika, {
		commit: {
			body: {
				batch: batch({
					changes: [{ noteId: "aaaaaaaaaaaa", revision: 1, action: "save", title: `Title ${DIRTY}`, created: true }],
				}),
				index: `# Project memory\n- Title ${DIRTY} [aaaaaaaaaaaa]\n`,
				indexBytes: 40,
				indexLines: 2,
			},
		},
	});
	setCredentials(pika.url);
	resetDreams();
	spawner = fakeSpawner();
	ui = new RecordingUI();
	h = await startSession({ workspace, ui: ui.context() });
});

afterEach(async () => {
	currentDream()?.stop("stopped", "the test ended");
	await h.shutdown();
	resetDreams();
	await pika.stop();
	await workspace.cleanup();
});

async function dream(): Promise<FakeChild> {
	await h.session.prompt("/memory dream");
	const deadline = performance.now() + 5_000;
	while (performance.now() < deadline) {
		if (spawner.children[0]?.prompts.length === 1) return spawner.children[0]!;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("timed out waiting for the kickoff");
}

it("strips ANSI/OSC/CSI control sequences from rendered dream tool output while preserving raw result.content and theme styling", async () => {
	const child = await dream();
	const saveArgs = {
		expectedRevision: 0, scope: "project", category: "project",
		title: `Title ${DIRTY}`, hook: `Hook ${DIRTY}`, body: `Body ${DIRTY}`, sources: SOURCES,
	};
	const forgetArgs = { id: `note-${DIRTY}`, expectedRevision: 2 };
	const commitArgs = { sessions: ["s-past-1"] };

	const saveTool = child.tool("dream_save");
	const forgetTool = child.tool("dream_forget");
	const commitTool = child.tool("dream_commit");

	const saveRes = await saveTool.execute("c1", saveArgs as never, undefined, undefined, undefined as never);
	const forgetRes = await forgetTool.execute("c2", forgetArgs as never, undefined, undefined, undefined as never);
	const commitRes = await commitTool.execute("c3", commitArgs as never, undefined, undefined, undefined as never);

	for (const [tool, res] of [[saveTool, saveRes], [forgetTool, forgetRes], [commitTool, commitRes]] as const) {
		const raw = res.content[0]?.type === "text" ? res.content[0].text : "";
		expect(raw).toContain(OSC52);
		expect(raw).toContain(CSI_RED);
		expect(raw).toContain(CSI_CLEAR);

		for (const expanded of [false, true]) {
			const rendered = lines(tool.renderResult!(res, { expanded, isPartial: false }, plainTheme, { isError: false } as never));
			expect(rendered).not.toContain("\x1b");
			expect(rendered).not.toContain("\x07");
			if (expanded || tool !== commitTool) expect(rendered).toContain("danger");

			const styled = lines(tool.renderResult!(res, { expanded, isPartial: false }, styledTheme, { isError: false } as never));
			expect(styled).not.toContain(OSC52);
			expect(styled).not.toContain(CSI_RED);
			expect(styled).not.toContain(CSI_CLEAR);
			expect(styled).not.toContain("\x07");
			if (!expanded) expect(styled).toContain("\x1b[32m");
		}
	}

	// Error result from a server 409 conflict with recorded control sequences strips sequences in renderResult while keeping raw content.
	const stored = note({ id: "cccccccccccc", revision: 5, title: `Stored ${DIRTY}`, body: `Body ${DIRTY}` });
	serveDreams(pika, { commit: { status: 409, body: { error: "revision_conflict", note: stored, change: 0 } } });
	await saveTool.execute("c4", saveArgs as never, undefined, undefined, undefined as never);
	const errRes = await commitTool.execute("c5", { sessions: ["s-past-1"] } as never, undefined, undefined, undefined as never);
	const rawErr = errRes.content[0]?.type === "text" ? errRes.content[0].text : "";
	expect(rawErr).toContain(OSC52);
	expect(rawErr).toContain(CSI_RED);
	expect(rawErr).toContain(CSI_CLEAR);
	for (const expanded of [false, true]) {
		const rendered = lines(commitTool.renderResult!(errRes, { expanded, isPartial: false }, plainTheme, { isError: true } as never));
		expect(rendered).not.toContain("\x1b");
		expect(rendered).not.toContain("\x07");
		const styled = lines(commitTool.renderResult!(errRes, { expanded, isPartial: false }, styledTheme, { isError: true } as never));
		expect(styled).toContain("\x1b[32m");
		expect(styled).not.toContain(OSC52);
		expect(styled).not.toContain(CSI_RED);
		expect(styled).not.toContain(CSI_CLEAR);
	}

	// renderCall strips control sequences from call arguments too.
	expect(lines(saveTool.renderCall!({ id: DIRTY, scope: "project", title: DIRTY } as never, plainTheme, {} as never))).toBe("dream_save danger · project · update danger");
	expect(lines(forgetTool.renderCall!({ id: DIRTY } as never, plainTheme, {} as never))).toBe("dream_forget danger");

	child.finish();
});
