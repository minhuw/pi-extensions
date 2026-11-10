import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { dreamSessionDir, inProjectPikaDir, outsideProject, READ_TOOLS } from "../../memory/dream/child.ts";
import { currentDream } from "../../memory/dream/index.ts";
import { FakePika } from "./support/pika-server.ts";
import { RecordingUI, releases, resetDreams, serveDreams } from "./support/dream.ts";
import { type Harness, PROJECT_SCOPE, setCredentials, startSession, USER_SCOPE, Workspace } from "./support/runtime.ts";

const OUTSIDE = "A dream reads only inside the project";
const PIKA_DIR = ".pi/pika/ holds earlier dreams' own sessions";
const SECRET = "the user's notes outside the project";
const TRANSCRIPT = "an earlier dream's transcript";

let workspace: Workspace;
let pika: FakePika;
let ui: RecordingUI;
let h: Harness | undefined;
/** The home `~` names in these tests: the test's own, next to the project. `<home>/outside/notes.txt` holds `SECRET`. */
let home: string;

beforeEach(async () => {
	workspace = await Workspace.create();
	home = join(workspace.root, "home");
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	// Without ripgrep or fd on the machine, `grep` and `find` fail instead of downloading them.
	vi.stubEnv("PI_OFFLINE", "1");
	await mkdir(join(home, "outside"), { recursive: true });
	await writeFile(join(home, "outside", "notes.txt"), `${SECRET}\n`);
	await mkdir(join(workspace.cwd, "src"));
	await writeFile(join(workspace.cwd, "src", "main.ts"), "export const answer = 42;\n");
	await writeFile(join(workspace.cwd, "README.md"), "the project's readme\n");
	await mkdir(dreamSessionDir(workspace.cwd), { recursive: true });
	await writeFile(join(dreamSessionDir(workspace.cwd), "old-dream.jsonl"), `{"secret":"${TRANSCRIPT}"}\n`);
	pika = await new FakePika().start();
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [], index: "" } });
	serveDreams(pika);
	setCredentials(pika.url);
	resetDreams();
	ui = new RecordingUI();
});
afterEach(async () => {
	currentDream()?.stop("stopped", "the test ended");
	await currentDream()?.done;
	await h?.shutdown();
	h = undefined;
	resetDreams();
	await pika.stop();
	vi.unstubAllEnvs();
	await workspace.cleanup();
});

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
	const deadline = performance.now() + ms;
	while (performance.now() < deadline) {
		if (check()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Runs a dream whose child makes `calls` in its first turn, and returns each call's result by its id. */
async function dream(calls: ReturnType<typeof fauxToolCall>[]): Promise<Record<string, { text: string; isError: boolean }>> {
	h = await startSession({ workspace, ui: ui.context() });
	const results: Record<string, { text: string; isError: boolean }> = {};
	h.faux.appendResponses([
		fauxAssistantMessage(calls, { stopReason: "toolUse" }),
		(context) => {
			for (const message of context.messages) {
				if (message.role !== "toolResult") continue;
				results[message.toolCallId] = { text: message.content.map((part) => part.type === "text" ? part.text : "").join(""), isError: message.isError };
			}
			return fauxAssistantMessage("Nothing to keep.");
		},
	]);
	await h.session.prompt("/memory dream");
	await until(() => releases(pika).length === 1, "the release");
	expect(Object.keys(results).sort()).toEqual(calls.map((call) => call.id).sort());
	return results;
}

it.each(READ_TOOLS)("%s is blocked outside the project and in .pi/pika/, and still runs inside the project", async (tool) => {
	await symlink(join(home, "outside"), join(workspace.cwd, "vendor"));
	// `read` takes the file, the others the directory holding it.
	const at = (dir: string, name: string) => tool === "read" ? `${dir}/${name}` : dir;
	const args = (path?: string) => ({ ...(tool === "grep" ? { pattern: "." } : tool === "find" ? { pattern: "*" } : {}), ...(path === undefined ? {} : { path }) });
	const absolute = at(join(home, "outside"), "notes.txt");
	const outside = { absolute, home: at("~/outside", "notes.txt"), at: `@${absolute}`, parent: at("../home/outside", "notes.txt"), symlink: at("vendor", "notes.txt"), url: `file://${absolute}` };
	const pikaDir = { pika: at(".pi/pika/dreams", "old-dream.jsonl"), pikaUrl: `file://${at(dreamSessionDir(workspace.cwd), "old-dream.jsonl")}` };
	const inside = { file: "README.md", directory: "src", absoluteInside: join(workspace.cwd, "src", "main.ts"), at: "@src" };
	const byId = await dream([
		...Object.entries(outside).map(([id, path]) => fauxToolCall(tool, args(path), { id: `outside-${id}` })),
		...Object.entries(pikaDir).map(([id, path]) => fauxToolCall(tool, args(path), { id })),
		...Object.entries(inside).map(([id, path]) => fauxToolCall(tool, args(path), { id: `inside-${id}` })),
		fauxToolCall(tool, args(), { id: "inside-none" }),
	]);

	for (const id of Object.keys(outside)) {
		const result = byId[`outside-${id}`]!;
		expect(result, id).toMatchObject({ isError: true });
		expect(result.text, id).toContain(OUTSIDE);
		expect(result.text, id).not.toContain(SECRET);
		expect(result.text, id).not.toContain("notes.txt");
	}
	for (const id of Object.keys(pikaDir)) {
		expect(byId[id], id).toMatchObject({ isError: true });
		expect(byId[id]!.text, id).toContain(PIKA_DIR);
		expect(byId[id]!.text, id).not.toContain(TRANSCRIPT);
	}
	// Not blocked: what the tool itself answers is its own, as `ls` of a file, `read` without a path, or `grep` without ripgrep.
	// A search of the project does not follow `vendor` out of it.
	for (const id of [...Object.keys(inside), "none"]) {
		const result = byId[`inside-${id}`]!;
		expect(result.text, id).not.toContain(OUTSIDE);
		expect(result.text, id).not.toContain(PIKA_DIR);
		expect(result.text, id).not.toContain(SECRET);
		expect(result.text, id).not.toContain("notes.txt");
	}
	if (tool === "read") {
		expect(byId["inside-file"]).toMatchObject({ isError: false, text: expect.stringContaining("the project's readme") });
		expect(byId["inside-absoluteInside"]).toMatchObject({ isError: false, text: expect.stringContaining("export const answer = 42;") });
	}
	if (tool === "ls") {
		expect(byId["inside-directory"]).toMatchObject({ isError: false, text: expect.stringContaining("main.ts") });
		expect(byId["inside-at"]).toMatchObject({ isError: false, text: expect.stringContaining("main.ts") });
		expect(byId["inside-none"]).toMatchObject({ isError: false, text: expect.stringContaining("README.md") });
		expect(byId["inside-none"]!.text).toContain("src/");
	}
});

it("resolves a path as the tools do: read's fallback spelling and a no-break space both lead through a symlink out of the project", async () => {
	// `read` opens `it’s` when `it's` does not exist, and every tool reads a no-break space as a space.
	await symlink(join(home, "outside"), join(workspace.cwd, "it\u2019s"));
	await symlink(join(home, "outside"), join(workspace.cwd, "my notes"));
	const byId = await dream([
		fauxToolCall("read", { path: "it's/notes.txt" }, { id: "spelling" }),
		fauxToolCall("read", { path: "my\u00A0notes/notes.txt" }, { id: "space" }),
		fauxToolCall("ls", { path: "my\u00A0notes" }, { id: "ls-space" }),
	]);
	for (const id of ["spelling", "space", "ls-space"]) {
		expect(byId[id], id).toMatchObject({ isError: true });
		expect(byId[id]!.text, id).toContain(OUTSIDE);
		expect(byId[id]!.text, id).not.toContain(SECRET);
		expect(byId[id]!.text, id).not.toContain("notes.txt");
	}
});

it("compares real paths: a working directory reached through a symlink holds its own files, and a symlink in it can lead outside", async () => {
	await symlink(join(home, "outside"), join(workspace.cwd, "vendor"));
	const actual = realpathSync(workspace.cwd);
	const alias = join(workspace.root, "alias");
	await symlink(actual, alias);
	for (const [cwd, other] of [[alias, actual], [actual, alias]] as const) {
		for (const path of ["README.md", "src", "", ".", "missing.txt", "missing/deeper.txt", join(other, "README.md"), join(other, "src"), join(other, "missing.txt"), other]) {
			expect(outsideProject(cwd, path), `${path} in ${cwd}`).toBe(false);
		}
		for (const path of ["vendor", "vendor/notes.txt", "vendor/missing.txt", join(other, "vendor", "notes.txt"), "..", join(other, ".."), `${other}-sibling`]) {
			expect(outsideProject(cwd, path), `${path} in ${cwd}`).toBe(true);
		}
		expect(inProjectPikaDir(cwd, join(other, ".pi", "pika", "dreams"))).toBe(true);
	}

	expect(outsideProject("/work/p", "/work/p2/x")).toBe(true);
	expect(outsideProject("/work/p", "src/../../p2")).toBe(true);
	expect(outsideProject("/work/p", "@~")).toBe(true);
	expect(outsideProject("/work/p", "file:///work/p2/x")).toBe(true);
	// A `file://` URL that names no local path opens nothing.
	expect(outsideProject("/work/p", "file://elsewhere/work/p/x")).toBe(true);
	expect(outsideProject("/work/p", "/work/p")).toBe(false);
	expect(outsideProject("/work/p", "@src/../README.md")).toBe(false);
	expect(outsideProject("/work/p", "file:///work/p/src")).toBe(false);
	// A name that only starts with two dots is in the project.
	expect(outsideProject("/work/p", "..cache/x")).toBe(false);
	expect(inProjectPikaDir("/work/p", "file:///work/p/.pi/pika/dreams/x.jsonl")).toBe(true);
});
