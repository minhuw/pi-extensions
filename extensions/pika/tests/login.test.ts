import { existsSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir, readdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadConfig, normalizeUrl } from "../config.ts";
import pikaExtension, { CHILD_SESSION_HOOKS, statusText, type ChildSessionHook } from "../index.ts";
import { isPlainRemote, login, MaskedInput, PASTE, URL_TITLE } from "../login.ts";
import { currentUploader } from "../uploader.ts";
import { MockIngest, TOKEN } from "./support/ingest-server.ts";
import { readText, startSession, waitFor, Workspace, type Harness } from "./support/runtime.ts";
import { plainTheme, ScriptedUI } from "./support/ui.ts";

const WRONG = `pika_${"ab".repeat(32)}`;
const ENTER = "\r";
const ESC = "\x1b";
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

let workspace: Workspace;
let ingest: MockIngest;
const servers: MockIngest[] = [];
beforeEach(async () => { workspace = await Workspace.create(); ingest = await new MockIngest().start(); });
afterEach(async () => {
	for (const name of ["PIKA_URL", "PIKA_TOKEN", "PIKA_DISABLED"]) delete process.env[name];
	for (const server of servers.splice(0)) await server.stop();
	await ingest.stop();
	await workspace.cleanup();
});

const configFile = () => join(workspace.agentDir, "pika.json");
const fileText = async () => existsSync(configFile()) ? await readFile(configFile(), "utf8") : undefined;
const registered = () => [...((globalThis as Record<symbol, Set<ChildSessionHook> | undefined>)[CHILD_SESSION_HOOKS] ?? [])];
const spooled = async () => (await readdir(join(workspace.pikaDir, "spool", "requests")).catch(() => [])).filter((name) => !name.endsWith(".tmp"));

async function session(ui: ScriptedUI, options: { mode?: "tui" | "rpc"; sessionManager?: SessionManager } = {}): Promise<Harness> {
	return startSession({ workspace, extensions: [pikaExtension], ui: ui.context(), mode: options.mode ?? "rpc", ...(options.sessionManager ? { sessionManager: options.sessionManager } : {}) });
}

/** Runs one command in a fresh session with `ui` and shuts the session down. */
async function command(ui: ScriptedUI, text: string, mode: "tui" | "rpc" = "rpc"): Promise<void> {
	const h = await session(ui, { mode });
	try {
		await h.session.prompt(text);
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}

/** No secret in what pika showed or asked, what `/pika` would show now, the uploader's last error, or `files`. */
async function expectNoSecret(ui: ScriptedUI, secrets: string[], files: string[] = []): Promise<void> {
	const texts = [
		...ui.messages, ...ui.prompts.map((prompt) => `${prompt.title} ${prompt.placeholder ?? ""}`), ...ui.rendered,
		statusText(loadConfig(workspace.agentDir), true, undefined, undefined), currentUploader()?.status().lastError ?? "",
	];
	for (const file of files) texts.push(await readFile(file, "utf8"));
	for (const secret of secrets) for (const text of texts) expect(text).not.toContain(secret);
}

describe("/pika login", () => {
	it("validates the token, then saves it with mode 0600, keeping other fields and dropping enabled: false", async () => {
		await workspace.configure({ exclude: ["/nowhere"], enabled: false, custom: { keep: true } });
		const ui = new ScriptedUI();
		ui.inputs = [`${ingest.url}//`, ` ${TOKEN} `];
		ui.choices = [PASTE];
		await command(ui, "/pika login");

		expect(JSON.parse((await fileText())!)).toEqual({ exclude: ["/nowhere"], custom: { keep: true }, url: ingest.url, token: TOKEN });
		expect(await fileText()).toMatch(/\n$/);
		expect((await stat(configFile())).mode & 0o777).toBe(0o600);
		expect((await readdir(workspace.agentDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		// The URL prompt, then the token prompt, which says it cannot be masked over RPC.
		expect(ui.prompts[0]!.title).toMatch(/server URL/);
		expect(ui.selects).toEqual([{ title: "How should this machine log in?", options: ["Pair with the pika web UI (recommended)", "Paste a token"] }]);
		expect(ui.prompts[1]!.title).toBe(`pika token for ${ingest.url} (pika cannot mask it in this client)`);
		expect(ui.last).toMatchObject({ type: "info", message: expect.stringContaining(`Logged in to ${ingest.url}`) });
		expect(ui.last!.message).toMatch(/"enabled": false/);
		expect(ui.last!.message).toMatch(/This session now uploads/);
		await expectNoSecret(ui, [TOKEN]);
		// The check is an ordinary empty batch with the uploader's client object.
		expect(ingest.bodies[0]).toEqual({ client: { host: expect.any(String), pikaVersion: expect.any(String), piVersion: expect.any(String) } });
		expect(ingest.headers[0]).toMatchObject({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
	}, 20_000);

	it("creates the agent dir and file when neither exists", async () => {
		const agentDir = join(workspace.root, "fresh-agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const ui = new ScriptedUI();
		ui.inputs = [TOKEN];
		ui.choices = [PASTE];
		const h = await startSession({ workspace, extensions: [pikaExtension], ui: ui.context() });
		try {
			await h.session.prompt(`/pika login ${ingest.url}`);
		} finally { await h.shutdown(); process.env.PI_CODING_AGENT_DIR = workspace.agentDir; }
		expect(JSON.parse(await readFile(join(agentDir, "pika.json"), "utf8"))).toEqual({ url: ingest.url, token: TOKEN });
		expect((await stat(join(agentDir, "pika.json"))).mode & 0o777).toBe(0o600);
	}, 20_000);

	const failures: { name: string; url: () => string; token: string; setup?: () => Promise<void> | void; message: (url: string) => string }[] = [
		{ name: "a wrong token (401)", url: () => ingest.url, token: WRONG, message: () => "the server rejected the token" },
		{ name: "a URL without the base path (404)", url: () => `http://127.0.0.1:${ingest.port}`, token: TOKEN, message: (url) => `no pika ingest API at ${url}; check the base path` },
		{ name: "an unexpected status", url: () => ingest.url, token: TOKEN, setup: () => { ingest.mode = "fail"; }, message: (url) => `unexpected HTTP 503 from ${url}` },
		{ name: "an unreachable server", url: () => ingest.url, token: TOKEN, setup: () => ingest.stop(), message: (url) => `could not reach ${url}` },
		{ name: "a redirect", url: () => ingest.url, token: TOKEN, setup: () => { ingest.mode = "redirect"; }, message: (url) => `could not reach ${url}` },
	];
	for (const existing of [undefined, `{ "url": "http://old.example/pika", "token": "old-token",\n  "exclude": ["/x"], "enabled": false }`]) {
		it.each(failures)(`changes nothing on $name${existing ? "" : " (no pika.json)"}`, async ({ url, token, setup, message }) => {
			if (existing) await writeFile(configFile(), existing);
			const target = url();
			await setup?.();
			const ui = new ScriptedUI();
			ui.inputs = [token];
			ui.choices = [PASTE];
			await command(ui, `/pika login ${target}`);
			expect(await fileText()).toBe(existing);
			expect(ui.last).toEqual({ type: "error", message: `pika login failed: ${message(target)}. Nothing changed.` });
			await expectNoSecret(ui, [token, "old-token"]);
			expect(currentUploader()).toBeUndefined();
		}, 20_000);
	}

	it("changes nothing when the URL prompt, method choice, or token prompt is cancelled or the token is blank, and never reuses the stored token", async () => {
		const existing = JSON.stringify({ url: ingest.url, token: TOKEN });
		await writeFile(configFile(), existing);
		for (const [inputs, choice, outcome] of [
			[[undefined], PASTE, "pika login cancelled. Nothing changed."],
			[[""], undefined, "pika login cancelled. Nothing changed."],
			[["", undefined], PASTE, "pika login cancelled. Nothing changed."],
			[["", "   "], PASTE, "pika login failed: no token entered. Nothing changed."],
		] as const) {
			const ui = new ScriptedUI();
			ui.inputs = [...inputs];
			ui.choices = [choice];
			await command(ui, "/pika login");
			expect(ui.last?.message).toBe(outcome);
			expect(ui.prompts[0]).toEqual({ title: `pika server URL: the address you open the pika web UI at, e.g. https://pika.example.com or http://192.168.1.10:7171 (blank keeps ${ingest.url})`, placeholder: ingest.url });
			expect(await fileText()).toBe(existing);
		}
		// No request ever carried the stored token.
		expect(ingest.bodies).toEqual([]);
	}, 30_000);

	it("keeps the current URL on a blank answer, and asks again with a warning for a blank or invalid one", async () => {
		await workspace.configure({ url: `${ingest.url}/`, token: "stored" });
		const ui = new ScriptedUI();
		ui.inputs = ["  ", TOKEN];
		ui.choices = [PASTE];
		await command(ui, "/pika login");
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token: TOKEN });

		await workspace.configure(undefined);
		const retry = new ScriptedUI();
		retry.inputs = ["", "pika.example.com", "192.168.1.10:7171", "ftp://host/pika", "https://user:pw@host", "https://host/pika?x=1", "http://", `${ingest.url}/`, TOKEN];
		retry.choices = [PASTE];
		await command(retry, "/pika login");
		expect(URL_TITLE).toBe("pika server URL: the address you open the pika web UI at, e.g. https://pika.example.com or http://192.168.1.10:7171");
		expect(retry.prompts.slice(0, 8)).toEqual(Array(8).fill({ title: URL_TITLE, placeholder: "https://pika.example.com" }));
		const hint = "Enter the address you open the pika web UI at, e.g. https://pika.example.com, or press Esc to cancel.";
		expect(retry.notes.filter((note) => note.type === "warning")).toEqual([
			"no server URL entered, and none is saved to keep",
			"the server URL must start with http:// or https://",
			"the server URL must start with http:// or https://",
			"the server URL must start with http:// or https://",
			"the server URL must not contain credentials",
			"the server URL must not have a query or fragment",
			"the server URL is not a valid URL",
		].map((problem) => ({ type: "warning", message: `pika: ${problem}. ${hint}` })));
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token: TOKEN });
		await expectNoSecret(retry, ["pw@"]);

		const cancelled = new ScriptedUI();
		await workspace.configure(undefined);
		cancelled.inputs = ["nope", undefined];
		await command(cancelled, "/pika login");
		expect(cancelled.last).toEqual({ type: "info", message: "pika login cancelled. Nothing changed." });
		expect(cancelled.selects).toEqual([]);
		expect(await fileText()).toBeUndefined();
	}, 20_000);

	it("asks for the URL the same way in the TUI", async () => {
		const ui = new ScriptedUI();
		ui.inputs = ["", ingest.url];
		ui.choices = [PASTE];
		ui.keys = [[paste(TOKEN), ENTER]];
		await command(ui, "/pika login", "tui");
		expect(ui.prompts).toEqual([{ title: URL_TITLE, placeholder: "https://pika.example.com" }, { title: URL_TITLE, placeholder: "https://pika.example.com" }]);
		expect(ui.notes[0]?.type).toBe("warning");
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token: TOKEN });
	}, 20_000);

	it.each(["{ not json", "[1, 2]", "\"text\""])("refuses a pika.json that is not a JSON object (%s) before asking anything", async (text) => {
		await writeFile(configFile(), text);
		const ui = new ScriptedUI();
		await command(ui, `/pika login ${ingest.url}`);
		expect(ui.last).toEqual({ type: "error", message: `pika login failed: ${configFile()} is not a JSON object; fix or remove it. Nothing changed.` });
		expect(ui.prompts).toEqual([]);
		expect(await fileText()).toBe(text);
	}, 20_000);

	it("refuses URLs that are not plain http(s) base URLs without echoing them", async () => {
		for (const [url, reason] of [
			["ftp://host/pika", "the server URL must start with http:// or https://"],
			["https://user:secret-pass@host/pika", "the server URL must not contain credentials"],
			["https://host/pika?token=secret-query", "the server URL must not have a query or fragment"],
			["https://host/pika#secret-fragment", "the server URL must not have a query or fragment"],
			["secret-not-a-url", "the server URL is not a valid URL"],
		] as const) {
			const ui = new ScriptedUI();
			await command(ui, `/pika login ${url}`);
			expect(ui.last?.message).toBe(`pika login failed: ${reason}. Nothing changed.`);
			await expectNoSecret(ui, ["secret"]);
		}
		expect(await fileText()).toBeUndefined();
	}, 30_000);

	it("masks the token in the TUI and saves what was typed and pasted", async () => {
		const ui = new ScriptedUI();
		ui.inputs = [ingest.url];
		ui.choices = [PASTE];
		ui.keys = [["t", "e", "s", "x", "\x7f", paste("t-tok"), "e", "n", ENTER]];
		await command(ui, "/pika login", "tui");
		expect(JSON.parse((await fileText())!)).toMatchObject({ url: ingest.url, token: TOKEN });
		expect(ui.rendered).toContain(`pika token for ${ingest.url}`);
		expect(ui.rendered).toContain("•".repeat(TOKEN.length));
		await expectNoSecret(ui, ["t-tok", TOKEN]);
		// Only the URL went through an unmasked prompt.
		expect(ui.prompts).toHaveLength(1);

		const cancelled = new ScriptedUI();
		cancelled.inputs = [ingest.url];
		cancelled.choices = [PASTE];
		cancelled.keys = [[paste(WRONG), ESC]];
		const before = await fileText();
		await command(cancelled, "/pika login", "tui");
		expect(cancelled.last?.message).toBe("pika login cancelled. Nothing changed.");
		expect(await fileText()).toBe(before);
		await expectNoSecret(cancelled, [WRONG.slice(5, 11)]);
	}, 20_000);

	it("needs a UI", async () => {
		const notify = vi.fn();
		const ctx = { hasUI: false, mode: "print", ui: { notify } } as unknown as ExtensionCommandContext;
		expect(await login(ctx, configFile(), ingest.url, undefined)).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(`/pika login needs an interactive UI. Edit ${configFile()} or set PIKA_URL and PIKA_TOKEN instead.`, "error");
		expect(await fileText()).toBeUndefined();
	});

	it("starts uploading a session that began unconfigured, and switches to a second server", async () => {
		const ui = new ScriptedUI();
		const h = await session(ui);
		try {
			h.faux.setResponses([fauxAssistantMessage("before"), fauxAssistantMessage("after"), fauxAssistantMessage("switched"), fauxAssistantMessage("later")]);
			await h.session.prompt("before login");
			const key = `session:${h.session.sessionId}`;
			const file = h.session.sessionFile!;
			await h.session.prompt("/pika");
			expect(ui.last?.message).toMatch(/^pika is disabled: no server url and token configured .*\. Run \/pika login to set it up\.$/);
			expect(registered()).toEqual([]);

			ui.inputs = [ingest.url, TOKEN];
			ui.choices = [PASTE];
			await h.session.prompt("/pika login");
			// The whole file, from before the login too.
			await waitFor(async () => ingest.data(key) === await readText(file), 5_000, "upload after login");
			expect(registered().map((hook) => hook.name)).toEqual(["pika"]);
			await h.session.prompt("after login");
			await waitFor(async () => ingest.data(key) === await readText(file) && ingest.sessionRequests(h.session.sessionId).length === 1, 5_000, "next turn");

			const other = await new MockIngest().start();
			servers.push(other);
			ui.inputs = [TOKEN];
			ui.choices = [PASTE];
			await h.session.prompt(`/pika login ${other.url}`);
			expect(currentUploader()?.options.url).toBe(other.url);
			const sent = ingest.bodies.length;
			// The stream stays open on the new uploader after it has scanned the file.
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			await h.session.prompt("switched");
			// The cursor is the first server's; the second reports a gap and gets the whole file.
			await waitFor(async () => other.data(key) === await readText(file) && other.sessionRequests(h.session.sessionId).length === 1, 5_000, "upload to the second server");
			expect(other.gaps).toContain(key);
			expect(ingest.bodies.length).toBe(sent);
			expect(JSON.parse((await fileText())!)).toEqual({ url: other.url, token: TOKEN });
			await expectNoSecret(ui, [TOKEN], [file]);
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
		expect(registered()).toEqual([]);
	}, 30_000);

	it("moves child sessions to the new server too", async () => {
		await workspace.enable(ingest.url);
		const ui = new ScriptedUI();
		const main = await session(ui);
		try {
			main.faux.setResponses([fauxAssistantMessage("main"), fauxAssistantMessage("child one"), fauxAssistantMessage("child two")]);
			await main.session.prompt("main");
			const manager = SessionManager.create(workspace.cwd, workspace.sessionDir, { parentSession: main.session.sessionFile });
			const child = await startSession({ workspace, sessionManager: manager, faux: main.faux, extensions: registered().map((hook) => hook.extensionFactory) });
			try {
				await child.session.prompt("child one");
				const key = `session:${child.session.sessionId}`;
				await waitFor(async () => ingest.data(key) === await readText(child.session.sessionFile!), 5_000, "child upload");
				const other = await new MockIngest().start();
				servers.push(other);
				ui.inputs = [TOKEN];
				ui.choices = [PASTE];
				await main.session.prompt(`/pika login ${other.url}`);
				const sent = ingest.bodies.length;
				await new Promise((resolve) => setTimeout(resolve, 1_200));
				await child.session.prompt("child two");
				await waitFor(async () => other.data(key) === await readText(child.session.sessionFile!), 5_000, "child upload to the second server");
				expect(ingest.bodies.length).toBe(sent);
			} finally { await child.shutdown(); }
		} finally { await main.shutdown(); }
	}, 30_000);

	it("keeps uploading a Herder run's journal, and uploads its unchanged goal and plan again, after a switch to another server", async () => {
		await workspace.enable(ingest.url);
		const runId = "20261026-120000-5ca1";
		const runDir = join(workspace.root, "herder", runId);
		await mkdir(runDir, { recursive: true });
		const run = { runId, runDir, journalPath: join(runDir, "journal.jsonl"), goalPath: join(runDir, "goal.md"), planPath: join(runDir, "plan.md"), repo: "project", title: "Switch" };
		await writeFile(run.journalPath, `${JSON.stringify({ seq: 1, t: "run.started" })}\n`);
		await writeFile(run.goalPath, "# Goal\n");
		await writeFile(run.planPath, "# Plan\n");
		let api: ExtensionAPI | undefined;
		const ui = new ScriptedUI();
		const h = await startSession({ workspace, ui: ui.context(), mode: "rpc", extensions: [(pi) => { api = pi; }, pikaExtension] });
		try {
			const key = `herder:${runId}`;
			api!.events.emit("herder:run", run);
			await waitFor(async () => ingest.data(key) === await readText(run.journalPath) && ingest.documents.size === 2, 5_000, "the run on the first server");
			const other = await new MockIngest().start();
			servers.push(other);
			ui.inputs = [TOKEN];
			ui.choices = [PASTE];
			await h.session.prompt(`/pika login ${other.url}`);
			// The new uploader has caught up with the file and would archive a stream it did not take over as open.
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			// The cursor is the first server's; the second reports a gap and gets the whole journal.
			await appendFile(run.journalPath, `${JSON.stringify({ seq: 2, t: "step.started" })}\n`);
			await waitFor(async () => other.data(key) === await readText(run.journalPath), 5_000, "journal lines after the switch");
			expect(other.gaps).toContain(key);
			// The documents the first server acknowledged are not the second server's.
			await waitFor(() => other.documents.size === 2, 5_000, "the goal and plan on the second server");
			expect(other.documents.get(`herder:${runId}:goal.md`)).toMatchObject({ kind: "herder-goal", runId, content: "# Goal\n" });
			expect(other.documents.get(`herder:${runId}:plan.md`)).toMatchObject({ kind: "herder-plan", runId, content: "# Plan\n" });
			expect(ingest.documentUploads).toHaveLength(2);
			// A repeated event for the run does not open its stream a second time.
			api!.events.emit("herder:run", run);
			await appendFile(run.journalPath, `${JSON.stringify({ seq: 3, t: "run.completed" })}\n`);
			await waitFor(async () => other.data(key) === await readText(run.journalPath), 5_000, "journal lines after another event");
			expect(other.conflicts).toEqual([]);
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
	}, 30_000);

	it("starts a new uploader on every login, so uploads a 401 stopped resume once the token is accepted again", async () => {
		await workspace.enable(ingest.url);
		const ui = new ScriptedUI();
		const h = await session(ui);
		try {
			h.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
			const key = `session:${h.session.sessionId}`;
			const file = h.session.sessionFile!;
			await h.session.prompt("one");
			await waitFor(async () => ingest.data(key) === await readText(file), 5_000, "first upload");

			ingest.mode = "unauthorized";
			await h.session.prompt("two");
			await waitFor(() => currentUploader()?.isHalted === true, 5_000, "a 401");
			await h.session.prompt("/pika");
			expect(ui.last?.message).toMatch(/^Stopped: the server rejected the token \(401\)/m);
			const halted = currentUploader();

			// The server accepts the same token again, for example after its device was restored.
			ingest.mode = "ok";
			ui.inputs = [TOKEN];
			ui.choices = [PASTE];
			await h.session.prompt(`/pika login ${ingest.url}`);
			expect(ui.last).toMatchObject({ type: "info", message: expect.stringContaining(`Logged in to ${ingest.url}`) });
			expect(currentUploader()).not.toBe(halted);
			await waitFor(async () => ingest.data(key) === await readText(file) && ingest.sessionRequests(h.session.sessionId).length === 2, 5_000, "uploads after the login");
			await h.session.prompt("/pika");
			expect(ui.last?.message).toMatch(/^Last error: none$/m);
			expect(ui.last?.message).not.toMatch(/Stopped|401/);

			// A healthy uploader is replaced too, so a login also ends a long backoff.
			const healthy = currentUploader();
			ui.inputs = [TOKEN];
			ui.choices = [PASTE];
			await h.session.prompt(`/pika login ${ingest.url}`);
			expect(currentUploader()).not.toBe(healthy);
			await h.session.prompt("three");
			await waitFor(async () => ingest.data(key) === await readText(file) && ingest.sessionRequests(h.session.sessionId).length === 3, 5_000, "uploads after another login");
			await expectNoSecret(ui, [TOKEN], [file]);
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
	}, 30_000);

	it("warns when the environment overrides the saved login or PIKA_DISABLED=1 keeps uploads off", async () => {
		process.env.PIKA_URL = ingest.url;
		process.env.PIKA_TOKEN = TOKEN;
		const ui = new ScriptedUI();
		ui.inputs = [TOKEN];
		ui.choices = [PASTE];
		await command(ui, `/pika login ${ingest.url}`);
		expect(ui.last).toMatchObject({ type: "warning", message: expect.stringContaining("PIKA_URL and PIKA_TOKEN in the environment override the saved values.") });
		await expectNoSecret(ui, [TOKEN]);
		delete process.env.PIKA_URL;
		delete process.env.PIKA_TOKEN;

		process.env.PIKA_DISABLED = "1";
		const disabled = new ScriptedUI();
		disabled.inputs = [TOKEN];
		disabled.choices = [PASTE];
		const h = await session(disabled);
		try {
			h.faux.setResponses([fauxAssistantMessage("quiet")]);
			await h.session.prompt(`/pika login ${ingest.url}`);
			expect(disabled.last).toMatchObject({ type: "warning", message: expect.stringContaining("The login is saved, but PIKA_DISABLED=1 keeps uploads off.") });
			expect(disabled.last!.message).not.toMatch(/now uploads/);
			const checks = ingest.bodies.length;
			await h.session.prompt("hello");
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			expect(ingest.bodies.length).toBe(checks);
			expect(registered()).toEqual([]);
		} finally { await h.shutdown(); }
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token: TOKEN });
	}, 30_000);
});

describe("/pika logout", () => {
	it("removes the url and token, stops uploading at once, and keeps the spool for the next login", async () => {
		await workspace.enable(ingest.url, { exclude: ["/nowhere"], custom: 1 });
		const ui = new ScriptedUI();
		const h = await session(ui);
		try {
			h.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
			const key = `session:${h.session.sessionId}`;
			const file = h.session.sessionFile!;
			await h.session.prompt("one");
			await waitFor(async () => ingest.data(key) === await readText(file), 5_000, "first upload");

			// What the server has not received when the user logs out stays queued.
			await ingest.stop();
			await h.session.prompt("two");
			await waitFor(async () => (await spooled()).length === 1, 3_000, "a spooled request");
			await h.session.prompt("/pika logout");
			expect(JSON.parse((await fileText())!)).toEqual({ exclude: ["/nowhere"], custom: 1 });
			expect((await stat(configFile())).mode & 0o777).toBe(0o600);
			expect(ui.last).toMatchObject({ type: "info", message: expect.stringContaining("This process stopped uploading.") });
			expect(currentUploader()).toBeUndefined();
			expect(registered()).toEqual([]);

			const sent = ingest.bodies.length;
			await ingest.start();
			await h.session.prompt("three");
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			expect(ingest.bodies.length).toBe(sent);
			expect(await spooled()).toHaveLength(1);
			expect(existsSync(join(workspace.pikaDir, "streams", `${encodeURIComponent(key)}.json`))).toBe(true);

			await h.session.prompt("/pika");
			expect(ui.last?.message).toMatch(/Run \/pika login/);
			ui.inputs = [TOKEN];
			ui.choices = [PASTE];
			await h.session.prompt(`/pika login ${ingest.url}`);
			await waitFor(async () => ingest.data(key) === await readText(file) && ingest.sessionRequests(h.session.sessionId).length === 2, 5_000, "upload after logging in again");
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
	}, 30_000);

	it("attaches a child session that stayed open across the logout again on the next login", async () => {
		await workspace.enable(ingest.url);
		const ui = new ScriptedUI();
		const main = await session(ui);
		try {
			main.faux.setResponses([fauxAssistantMessage("main"), fauxAssistantMessage("child one"), fauxAssistantMessage("child two"), fauxAssistantMessage("child three")]);
			await main.session.prompt("main");
			const manager = SessionManager.create(workspace.cwd, workspace.sessionDir, { parentSession: main.session.sessionFile });
			const child = await startSession({ workspace, sessionManager: manager, faux: main.faux, extensions: registered().map((hook) => hook.extensionFactory) });
			try {
				const key = `session:${child.session.sessionId}`;
				const file = () => child.session.sessionFile!;
				await child.session.prompt("child one");
				await waitFor(async () => ingest.data(key) === await readText(file()), 5_000, "child upload");

				await main.session.prompt("/pika logout");
				await child.session.prompt("child two");
				ui.inputs = [TOKEN];
				ui.choices = [PASTE];
				await main.session.prompt(`/pika login ${ingest.url}`);
				await waitFor(async () => ingest.data(key) === await readText(file()), 5_000, "child lines from while logged out");
				// Long enough for the uploader to archive the child's stream if nothing had it open.
				await new Promise((resolve) => setTimeout(resolve, 1_200));
				await child.session.prompt("child three");
				// The call made while logged out was not captured; the one after the login is.
				await waitFor(async () => ingest.data(key) === await readText(file()) && ingest.sessionRequests(child.session.sessionId).length === 2, 5_000, "child upload after the login");
				expect(child.errors).toEqual([]);
			} finally { await child.shutdown(); }
			expect(main.errors).toEqual([]);
		} finally { await main.shutdown(); }
		expect(registered()).toEqual([]);
	}, 30_000);

	it("follows a symbolic link to pika.json: the link stays, and the file it points to gets the change with mode 0600", async () => {
		const target = join(workspace.root, "dotfiles", "pika.json");
		await mkdir(dirname(target));
		await writeFile(target, JSON.stringify({ exclude: ["/nowhere"] }));
		await chmod(target, 0o644);
		await symlink(join("..", "dotfiles", "pika.json"), configFile());
		const isLink = async () => (await lstat(configFile())).isSymbolicLink();
		const temps = async () => [...await readdir(workspace.agentDir), ...await readdir(dirname(target))].filter((name) => name.endsWith(".tmp"));

		const ui = new ScriptedUI();
		ui.inputs = [TOKEN];
		ui.choices = [PASTE];
		await command(ui, `/pika login ${ingest.url}`);
		expect(ui.last).toMatchObject({ type: "info", message: expect.stringContaining(`Logged in to ${ingest.url}`) });
		expect(await isLink()).toBe(true);
		expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ exclude: ["/nowhere"], url: ingest.url, token: TOKEN });
		expect((await stat(target)).mode & 0o777).toBe(0o600);
		expect(await temps()).toEqual([]);

		await chmod(target, 0o644);
		const out = new ScriptedUI();
		await command(out, "/pika logout");
		expect(out.last).toMatchObject({ type: "info", message: expect.stringContaining("Logged out of pika") });
		expect(await isLink()).toBe(true);
		expect(await readFile(target, "utf8")).not.toContain(TOKEN);
		expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ exclude: ["/nowhere"] });
		expect((await stat(target)).mode & 0o777).toBe(0o600);
		expect(await temps()).toEqual([]);
	}, 20_000);

	it("refuses a symbolic link to a missing file and changes nothing", async () => {
		const target = join(workspace.root, "dotfiles", "pika.json");
		await symlink(target, configFile());
		const refused = `${configFile()} is a symbolic link to ${target}, which does not exist; fix or remove the link`;
		const ui = new ScriptedUI();
		await command(ui, `/pika login ${ingest.url}`);
		expect(ui.last).toEqual({ type: "error", message: `pika login failed: ${refused}. Nothing changed.` });
		expect(ui.prompts).toEqual([]);
		const out = new ScriptedUI();
		await command(out, "/pika logout");
		expect(out.last).toEqual({ type: "error", message: `pika logout failed: ${refused}. Nothing changed.` });
		expect(await readlink(configFile())).toBe(target);
		expect(existsSync(dirname(target))).toBe(false);
	}, 20_000);

	it("says when there is nothing to log out, and warns about credentials in the environment", async () => {
		const ui = new ScriptedUI();
		await command(ui, "/pika logout");
		expect(ui.last).toEqual({ type: "info", message: `pika: nothing to log out; ${configFile()} has no url or token.` });
		expect(await fileText()).toBeUndefined();

		await workspace.configure({ url: ingest.url, token: TOKEN });
		process.env.PIKA_TOKEN = TOKEN;
		const env = new ScriptedUI();
		await command(env, "/pika logout");
		expect(env.last).toMatchObject({ type: "warning", message: expect.stringContaining("PIKA_TOKEN is set in the environment, so new sessions still use it.") });
		expect(JSON.parse((await fileText())!)).toEqual({});
		await expectNoSecret(env, [TOKEN]);
	}, 20_000);
});

describe("/pika", () => {
	it("shows a usage line for unknown arguments and completes subcommands", async () => {
		const ui = new ScriptedUI();
		const h = await session(ui);
		try {
			for (const text of ["/pika bogus", "/pika status now", "/pika logout now", "/pika login a b"]) {
				await h.session.prompt(text);
				expect(ui.last).toEqual({ type: "error", message: "Usage: /pika [status|login [url]|logout]" });
			}
			const command = h.session.extensionRunner.getCommand("pika")!;
			expect(await command.getArgumentCompletions!("lo")).toEqual([{ value: "login", label: "login" }, { value: "logout", label: "logout" }]);
			expect(await command.getArgumentCompletions!("x")).toBeNull();
			expect(await command.getArgumentCompletions!("logout")).toBeNull();
		} finally { await h.shutdown(); }
	}, 20_000);
});

describe("MaskedInput", () => {
	const make = () => {
		const results: (string | undefined)[] = [];
		const render = vi.fn();
		const input = new MaskedInput("pika token for https://h/pika", { requestRender: render }, plainTheme, (token) => results.push(token));
		return { input, results, render, type: (...keys: string[]) => { for (const key of keys) input.handleInput(key); } };
	};
	const token = `pika_${"0123456789abcdef".repeat(4)}`;

	it("renders one bullet per character, truncated to the width, and never the characters", () => {
		const { input, type, render } = make();
		expect(input.render(80)).toEqual(["pika token for https://h/pika", "(empty)", "enter confirm · esc cancel"]);
		type(...token.slice(0, 10));
		type(paste(token.slice(10)));
		expect(render).toHaveBeenCalled();
		const lines = input.render(200);
		expect(lines[1]).toBe("•".repeat(token.length));
		for (const width of [1, 10, 30, 200]) {
			const narrow = input.render(width);
			expect(narrow).toHaveLength(3);
			for (const line of narrow) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				for (let at = 0; at + 5 <= token.length; at++) expect(line).not.toContain(token.slice(at, at + 5));
			}
		}
		type("\x7f", "\x7f");
		expect(input.render(200)[1]).toBe("•".repeat(token.length - 2));
	});

	it("resolves with the value on Enter and undefined on Esc, once", () => {
		const entered = make();
		entered.type(paste(token), ENTER, ENTER, ESC);
		expect(entered.results).toEqual([token]);
		const escaped = make();
		escaped.type("abc", ESC, ENTER);
		expect(escaped.results).toEqual([undefined]);
	});
});

it("normalizes server URLs and tells plain remote http apart", () => {
	expect(normalizeUrl(" https://Host.example:8443/pika/// ")).toBe("https://host.example:8443/pika");
	expect(normalizeUrl("http://h")).toBe("http://h");
	expect(normalizeUrl("http://h/a/b/")).toBe("http://h/a/b");
	expect(() => normalizeUrl("https://h/pika?")).toThrow(/query or fragment/);
	expect(isPlainRemote("http://homelab.example/pika")).toBe(true);
	expect(isPlainRemote("https://homelab.example/pika")).toBe(false);
	for (const url of ["http://localhost:7171", "http://127.0.0.1/pika", "http://[::1]:7171", "http://pika.localhost"]) expect(isPlainRemote(url)).toBe(false);
});
