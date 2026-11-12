import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import pikaExtension from "../index.ts";
import { PROJECT_CONFIG, resolveRepository } from "../repository.ts";
import { MockIngest } from "./support/ingest-server.ts";
import { readText, startSession, waitFor, Workspace } from "./support/runtime.ts";
import { ScriptedUI } from "./support/ui.ts";

const A = "https://github.com/me/app-a";
const B = "https://github.com/me/app-b";

/** git without the ambient GIT_* variables, which could point it elsewhere. */
function git(cwd: string, ...args: string[]): string {
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
	return execFileSync("git", ["-C", cwd, "-c", "user.name=pika", "-c", "user.email=pika@example.com", "-c", "init.defaultBranch=main", ...args], { env, encoding: "utf8" });
}

let workspace: Workspace;
let ingest: MockIngest;
let root: string;
beforeEach(async () => {
	workspace = await Workspace.create();
	ingest = await new MockIngest().start();
	root = await realpath(await mkdtemp(join(tmpdir(), "pika-project-")));
});
afterEach(async () => {
	await ingest.stop();
	await workspace.cleanup();
	await rm(root, { recursive: true, force: true });
});

/** A repository `app` with one commit and the given remotes, in config order. */
async function makeRepo(remotes: [string, string][]): Promise<string> {
	const repo = join(root, "app");
	await mkdir(repo, { recursive: true });
	git(repo, "init", "-q");
	for (const [name, url] of remotes) git(repo, "remote", "add", name, url);
	await writeFile(join(repo, "README"), "x\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	return repo;
}

const configOf = async (repo: string) => JSON.parse(await readFile(join(repo, PROJECT_CONFIG), "utf8")) as unknown;
const noteAbout = (ui: ScriptedUI, text: string) => ui.messages.some((message) => message.includes(text));

/** Sends one prompt and waits until the session file is uploaded whole; returns the stream's latest meta. */
async function uploadedMeta(h: Awaited<ReturnType<typeof startSession>>): Promise<unknown> {
	h.faux.appendResponses([fauxAssistantMessage("answer")]);
	await h.session.prompt("hello");
	const key = `session:${h.session.sessionId}`;
	await waitFor(async () => ingest.data(key) === await readText(h.session.sessionFile!), 5_000, "upload");
	return ingest.streams.get(key)!.meta;
}

it("asks a TUI session which remote identifies a repository without origin, and saves the answer where git ignores it", async () => {
	const repo = await makeRepo([["a", A], ["b", B]]);
	await workspace.enable(ingest.url);
	const ui = new ScriptedUI();
	ui.choices = [`b  ${B}`];
	const h = await startSession({ workspace, cwd: repo, extensions: [pikaExtension], mode: "tui", ui: ui.context() });
	try {
		await waitFor(() => noteAbout(ui, "is now project"), 5_000, "the answer");
		expect(ui.selects).toEqual([{ title: expect.stringContaining("which remote identifies app? It has several and none is \"origin\""), options: [`a  ${A}`, `b  ${B}`, "None of these: I'll type a project name"] }]);
		expect(await configOf(repo)).toEqual({ remote: "b" });
		expect(await readFile(join(repo, ".pi", "pika", ".gitignore"), "utf8")).toBe("*\n");
		expect(git(repo, "status", "--porcelain")).toBe("");
		expect(await resolveRepository(repo)).toEqual({ project: "app", repository: B });
		// The session's next upload carries the identity the user chose.
		expect(await uploadedMeta(h)).toMatchObject({ project: "app", repository: B });
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}, 20_000);

it("asks for a name when no remote has a web URL, and keeps asking until the name is valid", async () => {
	const repo = await makeRepo([["origin", "/srv/git/app.git"]]);
	await workspace.enable(ingest.url);
	const ui = new ScriptedUI();
	ui.inputs = ["a/b", "tool"];
	const h = await startSession({ workspace, cwd: repo, extensions: [pikaExtension], mode: "tui", ui: ui.context() });
	try {
		await waitFor(() => noteAbout(ui, "is now project"), 5_000, "the answer");
		expect(ui.selects).toEqual([]);
		expect(ui.prompts.map((prompt) => prompt.title)).toEqual([
			expect.stringContaining("project name for app?"),
			expect.stringContaining('"a/b" can\'t be a project name'),
		]);
		expect(ui.prompts[0]!.placeholder).toBe("app");
		expect(await configOf(repo)).toEqual({ remote: null, project: "tool" });
		expect(ui.messages.join("\n")).toContain("project tool on this device only");
		expect(await uploadedMeta(h)).toEqual({ sessionId: h.session.sessionId, cwd: repo, project: "tool" });
		// A remote added later does not move a named repository.
		git(repo, "remote", "add", "github", A);
		expect(await resolveRepository(repo)).toEqual({ project: "tool" });
	} finally { await h.shutdown(); }
}, 20_000);

it("keeps the folder's name when Enter is pressed on the name", async () => {
	const repo = await makeRepo([]);
	await workspace.enable(ingest.url);
	const ui = new ScriptedUI();
	ui.inputs = [""];
	const h = await startSession({ workspace, cwd: repo, extensions: [pikaExtension], mode: "tui", ui: ui.context() });
	try {
		await waitFor(() => noteAbout(ui, "is now project"), 5_000, "the answer");
		expect(await configOf(repo)).toEqual({ remote: null, project: "app" });
	} finally { await h.shutdown(); }
}, 20_000);

it("asks again when the saved remote is gone, offering the remotes left", async () => {
	const repo = await makeRepo([["origin", A], ["b", B]]);
	await mkdir(join(repo, ".pi", "pika"), { recursive: true });
	await writeFile(join(repo, PROJECT_CONFIG), JSON.stringify({ remote: "fork", project: "kept" }));
	await workspace.enable(ingest.url);
	const ui = new ScriptedUI();
	ui.choices = [`b  ${B}`];
	const h = await startSession({ workspace, cwd: repo, extensions: [pikaExtension], mode: "tui", ui: ui.context() });
	try {
		await waitFor(() => noteAbout(ui, "is now project"), 5_000, "the answer");
		expect(ui.selects[0]!.title).toContain('which remote identifies app now? The saved one, "fork", is gone');
		// The saved name stays with the newly chosen remote.
		expect(await configOf(repo)).toEqual({ remote: "b", project: "kept" });
	} finally { await h.shutdown(); }
}, 20_000);

it("writes nothing when the question is dismissed, and does not ask again in this process", async () => {
	const repo = await makeRepo([["a", A], ["b", B]]);
	await workspace.enable(ingest.url);
	const ui = new ScriptedUI();
	ui.choices = [undefined];
	const first = await startSession({ workspace, cwd: repo, extensions: [pikaExtension], mode: "tui", ui: ui.context() });
	try {
		await waitFor(() => noteAbout(ui, "pika asks again when pi next starts here"), 5_000, "the dismissal");
	} finally { await first.shutdown(); }
	expect(existsSync(join(repo, ".pi"))).toBe(false);
	const second = await startSession({ workspace, cwd: repo, extensions: [pikaExtension], mode: "tui", ui: ui.context() });
	try {
		await resolveRepository(repo);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(ui.selects).toHaveLength(1);
		expect(second.errors).toEqual([]);
	} finally { await second.shutdown(); }
}, 20_000);

it.each([
	{ case: "an RPC session", mode: "rpc" as const, enabled: true },
	{ case: "a print session", mode: "print" as const, enabled: true },
	{ case: "a session pika does not upload", mode: "tui" as const, enabled: false },
])("never asks in $case", async ({ mode, enabled }) => {
	const repo = await makeRepo([["a", A], ["b", B]]);
	if (enabled) await workspace.enable(ingest.url);
	const ui = new ScriptedUI();
	const h = await startSession({ workspace, cwd: repo, extensions: [pikaExtension], mode, ui: ui.context() });
	try {
		await resolveRepository(repo);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(ui.selects).toEqual([]);
		expect(ui.prompts).toEqual([]);
		expect(existsSync(join(repo, ".pi"))).toBe(false);
	} finally { await h.shutdown(); }
}, 20_000);

it("/pika project shows the identity and asks again, even when nothing is open", async () => {
	const repo = await makeRepo([["origin", A], ["b", B]]);
	await workspace.enable(ingest.url);
	const ui = new ScriptedUI();
	const h = await startSession({ workspace, cwd: repo, extensions: [pikaExtension], mode: "rpc", ui: ui.context() });
	try {
		ui.choices = ["None of these: I'll type a project name"];
		ui.inputs = ["renamed"];
		await h.session.prompt("/pika project");
		expect(ui.selects[0]!.title).toContain(`which remote identifies app? (now: project app, identified by ${A}; from its remotes`);
		expect(await configOf(repo)).toEqual({ remote: null, project: "renamed" });
		expect(ui.last!.message).toContain("this repository is now project renamed on this device only");

		ui.choices = [`origin  ${A}`];
		await h.session.prompt("/pika project");
		expect(await configOf(repo)).toEqual({ remote: "origin", project: "renamed" });
		expect(await resolveRepository(repo)).toEqual({ project: "renamed", repository: A });

		ui.choices = [undefined];
		await h.session.prompt("/pika project");
		expect(ui.last!.message).toBe("pika: nothing changed.");
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}, 20_000);

it("/pika project only reports without a UI or outside git", async () => {
	const repo = await makeRepo([["a", A], ["b", B]]);
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, cwd: repo, extensions: [pikaExtension], mode: "print" });
	try {
		await h.session.prompt("/pika project");
		expect(existsSync(join(repo, ".pi"))).toBe(false);
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
	const ui = new ScriptedUI();
	const outside = await startSession({ workspace, extensions: [pikaExtension], mode: "rpc", ui: ui.context() });
	try {
		await outside.session.prompt("/pika project");
		expect(ui.last!.message).toBe(`pika: ${workspace.cwd} is not in a git repository pika can name, so it has no project.`);
	} finally { await outside.shutdown(); }
}, 20_000);
