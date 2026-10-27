import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "../config.ts";
import pikaExtension, { statusText } from "../index.ts";
import { BIND_TIMEOUT_MS, bindOnce, deviceKey, deviceKeyFile, deviceKeyHooks } from "../device-key.ts";
import { login, nameTitle, PAIR, PASTE } from "../login.ts";
import { defaultDeviceName, PairingView, pairingLimits, startPairing, validDeviceName } from "../pairing.ts";
import { currentUploader, PIKA_VERSION } from "../uploader.ts";
import { MockIngest, TOKEN } from "./support/ingest-server.ts";
import { readText, startSession, waitFor, Workspace, type Harness } from "./support/runtime.ts";
import { plainTheme, ScriptedUI } from "./support/ui.ts";

const ESC = "\x1b";
const limits = { ...pairingLimits };

let workspace: Workspace;
let ingest: MockIngest;
beforeEach(async () => {
	workspace = await Workspace.create();
	ingest = await new MockIngest().start();
	// The contract's 2 s interval, shortened so a test takes a fraction of a second.
	ingest.pairInterval = 0.05;
	pairingLimits.minIntervalMs = 50;
});
afterEach(async () => {
	Object.assign(pairingLimits, limits);
	await ingest.stop();
	await workspace.cleanup();
});

const configFile = () => join(workspace.agentDir, "pika.json");
const fileText = async () => existsSync(configFile()) ? await readFile(configFile(), "utf8") : undefined;
const polls = () => ingest.pairRequests.filter((request) => request.path === "poll").length;
const link = (code: string) => `${ingest.url}/devices?pair=${code}`;
const EXISTING = `{ "url": "http://old.example/pika", "token": "old-token", "exclude": ["/x"] }`;

async function session(ui: ScriptedUI, mode: "tui" | "rpc" = "rpc"): Promise<Harness> {
	return startSession({ workspace, extensions: [pikaExtension], ui: ui.context(), mode });
}

/** Runs `/pika login <url>` in a fresh session that pairs, with `inputs` answering its prompts. */
async function pairLogin(ui: ScriptedUI, inputs: (string | undefined)[], mode: "tui" | "rpc" = "rpc"): Promise<void> {
	ui.choices = [PAIR];
	ui.inputs = inputs;
	const h = await session(ui, mode);
	try {
		await h.session.prompt(`/pika login ${ingest.url}`);
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}

/** This install's device key, when its file exists. */
const storedKey = (): string | undefined => {
	try { return (JSON.parse(readFileSync(deviceKeyFile(workspace.pikaDir), "utf8")) as { key?: string }).key; } catch { return undefined; }
};

/** Runs one command in a fresh session with `ui` and shuts the session down. */
async function command(ui: ScriptedUI, text: string): Promise<void> {
	const h = await session(ui);
	try {
		await h.session.prompt(text);
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}

/** No pairing secret, token, or device key in anything pika showed, asked, or would show in `/pika`. */
function expectNoSecret(ui: ScriptedUI, extra: string[] = []): void {
	const texts = [
		...ui.messages, ...ui.prompts.map((prompt) => `${prompt.title} ${prompt.placeholder ?? ""}`), ...ui.rendered,
		statusText(loadConfig(workspace.agentDir), true, undefined, undefined), currentUploader()?.status().lastError ?? "",
	];
	const key = storedKey();
	const secrets = [...ingest.pairingIds, ...[...ingest.devices.values()].flatMap((device) => device.token ? [device.token] : []), ...(key ? [key] : []), ...extra];
	expect(ingest.pairingIds.length + extra.length).toBeGreaterThan(0);
	for (const secret of secrets) for (const text of texts) expect(text).not.toContain(secret);
}

describe("/pika login pairing", () => {
	it("shows the code and approval page, saves the approved token like a pasted one, and starts uploading at once", async () => {
		await workspace.configure({ exclude: ["/nowhere"], enabled: false });
		const ui = new ScriptedUI();
		const h = await session(ui);
		try {
			h.faux.setResponses([fauxAssistantMessage("before"), fauxAssistantMessage("after")]);
			await h.session.prompt("before login");
			const key = `session:${h.session.sessionId}`;
			const file = h.session.sessionFile!;

			ui.choices = [PAIR];
			ui.inputs = [""];
			const running = h.session.prompt(`/pika login ${ingest.url}`);
			await waitFor(() => ingest.pendingPairings().length === 1, 5_000, "a pending pairing");
			const [pending] = ingest.pendingPairings();
			const device = defaultDeviceName();
			expect(pending).toMatchObject({ device, host: hostname(), pikaVersion: PIKA_VERSION });
			// This install's new device key goes with it; no token is configured, so none is sent.
			expect(ingest.pairRequests[0]).toEqual({ path: "start", body: { device, host: hostname(), pikaVersion: PIKA_VERSION, key: storedKey() } });
			expect(storedKey()).toMatch(/^[0-9a-f]{64}$/);
			await waitFor(() => ui.messages.some((message) => message.includes(link(pending!.code))), 5_000, "the approval link");
			expect(ui.last).toEqual({
				type: "info",
				message: `To pair this machine with pika as ${device}, open ${link(pending!.code)} and approve the code ${pending!.code}. The code expires in 10 minutes; waiting for approval…`,
			});
			expect(ingest.approve(pending!.code.toLowerCase().replace("-", ""))).toBe(200);
			await running;

			const token = ingest.deviceNamed(device).token!;
			expect(token).toMatch(/^pika_/);
			expect(ingest.deviceId(device)).toMatch(/^[0-9a-f-]{36}$/);
			expect(JSON.parse((await fileText())!)).toEqual({ exclude: ["/nowhere"], url: ingest.url, token });
			expect((await stat(configFile())).mode & 0o777).toBe(0o600);
			expect(ui.selects).toEqual([{ title: "How should this machine log in?", options: [PAIR, PASTE] }]);
			expect(ui.prompts).toEqual([{ title: `Name for this machine in pika (any text up to 64 characters; blank uses ${device})`, placeholder: device }]);
			expect(ui.last).toMatchObject({ type: "info", message: expect.stringContaining(`Logged in to ${ingest.url} as ${device}; saved to ${configFile()}. Removed`) });
			expect(ui.last!.message).toMatch(/This session now uploads/);
			expect(ui.last!.message).not.toMatch(/continues/);
			// The key is bound once, after the login; enabling pika in this session binds nothing more.
			await waitFor(() => ingest.binds.length === 1, 5_000, "the bind");
			expect(ingest.binds).toEqual([{ authorization: `Bearer ${token}`, body: { key: storedKey() }, status: 204 }]);
			// The approval was handed out once; the pairing is gone.
			expect(ingest.pairings.size).toBe(0);

			// Validated, then used for the whole session, with no restart.
			await waitFor(async () => ingest.data(key) === await readText(file), 5_000, "upload after pairing");
			await h.session.prompt("after login");
			await waitFor(async () => ingest.data(key) === await readText(file) && ingest.sessionRequests(h.session.sessionId).length === 1, 5_000, "next turn");
			expect(ingest.headers.every((headers) => headers.authorization === `Bearer ${token}`)).toBe(true);
			expect(currentUploader()?.options.token).toBe(token);
			expectNoSecret(ui);
			expect(await readText(file)).not.toContain(token);
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
	}, 30_000);

	it("shows the code, the page, the time left, and Esc in the TUI, and closes the view when approved", async () => {
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		const ui = new ScriptedUI();
		ui.keys = [[]];
		await pairLogin(ui, ["my-laptop"], "tui");
		const token = ingest.deviceNamed("my-laptop").token;
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token });
		const code = /^Code: (\S+)$/m.exec(ui.rendered.join("\n"))?.[1];
		expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
		expect(ui.rendered.join("")).toContain(link(code!));
		expect(ui.rendered).toContain("Pair this machine with pika");
		expect(ui.rendered.some((line) => /^Waiting for approval · expires in (10:00|9:5\d) · Esc cancels$/.test(line))).toBe(true);
		expect(ui.disposed).toBe(1);
		expect(ui.unfinished).toBe(0);
		expect(ui.last).toMatchObject({ type: "info", message: expect.stringContaining(`Logged in to ${ingest.url} as my-laptop`) });
		expectNoSecret(ui);
	}, 20_000);

	it("cancels with Esc in the TUI and changes nothing", async () => {
		await writeFile(configFile(), EXISTING);
		const ui = new ScriptedUI();
		ui.keys = [[ESC]];
		await pairLogin(ui, ["my-laptop"], "tui");
		expect(ui.last).toEqual({ type: "info", message: "pika login cancelled. Nothing changed." });
		expect(ui.unfinished).toBe(0);
		expect(await fileText()).toBe(EXISTING);
		expect(ui.disposed).toBe(1);
		// Nothing was approved; the code stays pending until it expires.
		expect(ingest.pendingPairings()).toHaveLength(1);
		expect(ingest.devices.size).toBe(0);
		expectNoSecret(ui);
	}, 20_000);

	const endings: { name: string; decide: (code: string) => void; message: string }[] = [
		{ name: "denied", decide: (code) => { ingest.deny(code); }, message: "the pairing was denied in the pika web UI" },
		{ name: "expired", decide: (code) => { ingest.expire(code); }, message: "the code expired before it was approved; run /pika login again" },
		{ name: "unknown to the server (404)", decide: () => { ingest.pairings.clear(); }, message: "the server no longer knows this pairing; run /pika login again" },
	];
	it.each(endings)("changes nothing when the pairing is $name", async ({ decide, message }) => {
		await writeFile(configFile(), EXISTING);
		ingest.onPairingStart = decide;
		const ui = new ScriptedUI();
		await pairLogin(ui, [""]);
		expect(ui.last).toEqual({ type: "error", message: `pika login failed: ${message}. Nothing changed.` });
		expect(await fileText()).toBe(EXISTING);
		expect(polls()).toBe(1);
		expect(ingest.bodies).toEqual([]);
		expect(currentUploader()).toBeUndefined();
		expectNoSecret(ui, ["old-token"]);
	}, 20_000);

	it("offers the token prompt when the server cannot pair (404 on start)", async () => {
		ingest.pairing = false;
		const ui = new ScriptedUI();
		await pairLogin(ui, ["desk-1.lab", TOKEN]);
		expect(ui.messages).toContain(`${ingest.url} cannot pair devices: it is a pika server older than 0.2. Paste a token from \`pika token create desk-1.lab\` instead.`);
		expect(ui.prompts[1]!.title).toBe(`pika token for ${ingest.url} (pika cannot mask it in this client)`);
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token: TOKEN });
		expect(ui.last).toMatchObject({ type: "info", message: expect.stringContaining(`Logged in to ${ingest.url}; saved`) });
		expectNoSecret(ui, [TOKEN]);
	}, 20_000);

	it("suggests a name such a server accepts when the chosen one has other characters", async () => {
		ingest.pairing = false;
		const ui = new ScriptedUI();
		await pairLogin(ui, ["  Minhu's Mac mini ", TOKEN]);
		expect(ui.messages).toContain(`${ingest.url} cannot pair devices: it is a pika server older than 0.2, which accepts only letters, digits, '.', '_', and '-' in device names. Paste a token from \`pika token create Minhu-s-Mac-mini\` instead.`);
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token: TOKEN });
	}, 20_000);

	it("stops waiting when the command's signal aborts", async () => {
		await writeFile(configFile(), EXISTING);
		const ui = new ScriptedUI();
		ui.choices = [PAIR];
		ui.inputs = [""];
		const controller = new AbortController();
		const ctx = { hasUI: true, mode: "rpc", signal: controller.signal, ui: ui.context() } as unknown as ExtensionCommandContext;
		const result = login(ctx, configFile(), ingest.url, undefined);
		await waitFor(() => polls() >= 2, 5_000, "polling");
		controller.abort();
		expect(await result).toBeUndefined();
		expect(ui.last).toEqual({ type: "info", message: "pika login cancelled. Nothing changed." });
		const count = polls();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(polls()).toBe(count);
		expect(await fileText()).toBe(EXISTING);
		expectNoSecret(ui);
	}, 20_000);

	// Pi gives a command no signal while no turn runs, so these cancel only through pika's own paths.
	it("cancels a waiting pairing when /pika logout runs, so approving the code later saves nothing", async () => {
		await writeFile(configFile(), EXISTING);
		const ui = new ScriptedUI();
		ui.choices = [PAIR];
		ui.inputs = [""];
		const h = await session(ui);
		try {
			const running = h.session.prompt(`/pika login ${ingest.url}`);
			await waitFor(() => polls() >= 1, 5_000, "polling");
			const [pending] = ingest.pendingPairings();
			await h.session.prompt("/pika logout");
			await running;
			expect(ui.messages).toContain("pika login cancelled: /pika logout ran. Nothing changed.");
			expect(ui.last).toEqual({
				type: "info",
				message: `Logged out of pika: removed the url and token from ${configFile()}. This process stopped uploading.\nQueued data stays in ${workspace.pikaDir} and uploads after the next login.\nCancelled the earlier /pika login, which was waiting for its pairing code to be approved.`,
			});
			const count = polls();
			expect(ingest.approve(pending!.code)).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 400));
			expect(polls()).toBe(count);
			expect(ingest.devices.size).toBe(0);
			expect(JSON.parse((await fileText())!)).toEqual({ exclude: ["/x"] });
			expect(currentUploader()).toBeUndefined();
			expect(loadConfig(workspace.agentDir).enabled).toBe(false);
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
		expectNoSecret(ui, ["old-token"]);
	}, 20_000);

	it("cancels a waiting pairing when another /pika login starts, and saves only the newer login", async () => {
		await writeFile(configFile(), EXISTING);
		const ui = new ScriptedUI();
		ui.choices = [PAIR, PAIR];
		ui.inputs = ["first-box", "second-box"];
		const h = await session(ui);
		try {
			const first = h.session.prompt(`/pika login ${ingest.url}`);
			await waitFor(() => polls() >= 1, 5_000, "the first pairing polling");
			const [abandoned] = ingest.pendingPairings();
			const second = h.session.prompt(`/pika login ${ingest.url}`);
			await first;
			expect(ui.messages).toContain("pika: Cancelled the earlier /pika login, which was waiting for its pairing code to be approved.");
			expect(ui.messages).toContain("pika login cancelled: a newer /pika login started. Nothing changed.");
			await waitFor(() => ingest.pendingPairings().some((pairing) => pairing.device === "second-box"), 5_000, "the second pairing");
			// The abandoned code is approved first; nothing polls for it any more.
			expect(ingest.approve(abandoned!.code)).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(await fileText()).toBe(EXISTING);
			const newer = ingest.pendingPairings().find((pairing) => pairing.device === "second-box")!;
			expect(ingest.approve(newer.code)).toBe(200);
			await second;
			expect([...ingest.devices.values()].map((device) => device.name)).toEqual(["second-box"]);
			const token = ingest.deviceNamed("second-box").token;
			expect(JSON.parse((await fileText())!)).toEqual({ exclude: ["/x"], url: ingest.url, token });
			expect(ui.last?.message).toMatch(new RegExp(`^Logged in to ${ingest.url} as second-box; saved`));
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
		expectNoSecret(ui, ["old-token"]);
	}, 20_000);

	it("cancels a waiting pairing when its session shuts down, so approving the code later saves and attaches nothing", async () => {
		await writeFile(configFile(), EXISTING);
		const ui = new ScriptedUI();
		ui.choices = [PAIR];
		ui.inputs = [""];
		const h = await session(ui);
		const running = h.session.prompt(`/pika login ${ingest.url}`);
		await waitFor(() => polls() >= 1, 5_000, "polling");
		const [pending] = ingest.pendingPairings();
		const shown = ui.notes.length;
		await h.shutdown();
		await running;
		const count = polls();
		expect(ingest.approve(pending!.code)).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(polls()).toBe(count);
		expect(ingest.devices.size).toBe(0);
		expect(await fileText()).toBe(EXISTING);
		expect(currentUploader()).toBeUndefined();
		// Nothing touched the closed session's context, which would have thrown.
		expect(ui.notes.length).toBe(shown);
		expect(h.errors).toEqual([]);
		// A new session in the process is not blocked by the cancelled login.
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		const next = new ScriptedUI();
		await pairLogin(next, ["next-box"]);
		expect(next.messages.some((message) => message.includes("Cancelled the earlier"))).toBe(false);
		expect(JSON.parse((await fileText())!)).toMatchObject({ url: ingest.url, token: ingest.deviceNamed("next-box").token });
	}, 20_000);

	it("saves nothing from an approval that arrives as /pika logout cancels the login, and names the device to revoke", async () => {
		await writeFile(configFile(), EXISTING);
		const ui = new ScriptedUI();
		ui.choices = [PAIR];
		ui.inputs = ["race-box"];
		const h = await session(ui);
		try {
			ingest.onPairingStart = (code) => { ingest.approve(code); };
			// The server has created the device; the logout runs before its answer arrives.
			ingest.onPoll = async (answer) => {
				if (answer.body.status === "approved") await h.session.prompt("/pika logout");
				return answer;
			};
			await h.session.prompt(`/pika login ${ingest.url}`);
			const id = ingest.deviceId("race-box");
			expect(ui.notes).toContainEqual({
				type: "error",
				message: `pika login cancelled: /pika logout ran. The pairing created the device race-box (${id}) on ${ingest.url}, but this machine did not keep its token; revoke race-box (${id}) on the Devices page (${ingest.url}/devices). ${configFile()} is unchanged.`,
			});
			expect(JSON.parse((await fileText())!)).toEqual({ exclude: ["/x"] });
			expect(ingest.bodies).toEqual([]);
			expect(currentUploader()).toBeUndefined();
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
		expectNoSecret(ui, ["old-token"]);
	}, 20_000);

	it("keeps an approval that arrives as the command's own signal aborts, since the login is still current", async () => {
		const ui = new ScriptedUI();
		ui.choices = [PAIR];
		ui.inputs = ["kept-box"];
		const controller = new AbortController();
		const ctx = { hasUI: true, mode: "rpc", signal: controller.signal, ui: ui.context() } as unknown as ExtensionCommandContext;
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		ingest.onPoll = (answer) => { if (answer.body.status === "approved") controller.abort(); return answer; };
		const saved = await login(ctx, configFile(), ingest.url, undefined);
		expect(saved).toEqual({ url: ingest.url, file: configFile(), reenabled: false, device: { id: ingest.deviceId("kept-box"), name: "kept-box", continued: false } });
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token: ingest.deviceNamed("kept-box").token });
		expectNoSecret(ui);
	}, 20_000);

	it("names the device it created when the approved token fails validation, and saves nothing", async () => {
		await writeFile(configFile(), EXISTING);
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		// Like a proxy that leaves /api/pair/ open but blocks /api/ingest/.
		ingest.onPoll = (answer) => { if (answer.body.status === "approved") ingest.mode = "fail"; return answer; };
		const ui = new ScriptedUI();
		await pairLogin(ui, ["proxied-box"]);
		const id = ingest.deviceId("proxied-box");
		expect(ui.last).toEqual({
			type: "error",
			message: `pika login failed: unexpected HTTP 503 from ${ingest.url}. The pairing created the device proxied-box (${id}) on ${ingest.url}, but this machine did not keep its token; revoke proxied-box (${id}) on the Devices page (${ingest.url}/devices). ${configFile()} is unchanged.`,
		});
		expect(await fileText()).toBe(EXISTING);
		expectNoSecret(ui, ["old-token"]);
	}, 20_000);

	it("treats an approval without a token as a failure, saves nothing, and names the device", async () => {
		await writeFile(configFile(), EXISTING);
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		ingest.onPoll = ({ status, body: { token: _token, ...body } }) => ({ status, body });
		const ui = new ScriptedUI();
		await pairLogin(ui, ["tokenless"]);
		const id = ingest.deviceId("tokenless");
		expect(ui.last).toEqual({
			type: "error",
			message: `pika login failed: the server approved the pairing but sent no token. The pairing created the device tokenless (${id}) on ${ingest.url}, but this machine did not keep its token; revoke tokenless (${id}) on the Devices page (${ingest.url}/devices). ${configFile()} is unchanged.`,
		});
		expect(await fileText()).toBe(EXISTING);
		expect(ingest.bodies).toEqual([]);
		expectNoSecret(ui, ["old-token"]);
	}, 20_000);

	it("keeps waiting through failed polls that are not three in a row", async () => {
		let code: string | undefined;
		ingest.onPairingStart = (started) => { code = started; };
		let count = 0;
		// Two failures, a pending answer, two more failures, then the approval.
		ingest.onPoll = (answer) => {
			count++;
			if (count === 5) ingest.approve(code!);
			return count === 3 || count >= 6 ? answer : { status: 503, body: { error: "unavailable" } };
		};
		const ui = new ScriptedUI();
		await pairLogin(ui, ["flaky-box"]);
		expect(count).toBe(6);
		expect(ui.last?.message).toMatch(new RegExp(`^Logged in to ${ingest.url} as flaky-box; saved`));
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token: ingest.deviceNamed("flaky-box").token });
	}, 20_000);

	it("reports too many pending pairings on start and changes nothing", async () => {
		await writeFile(configFile(), EXISTING);
		for (let i = 0; i < 10; i++) {
			ingest.pairings.set(`pending-${i}`, { code: `AAAA-AAA${i}`, device: `d${i}`, requestedAt: Date.now(), expiresAt: Date.now() + 600_000, state: "pending" });
		}
		const ui = new ScriptedUI();
		await pairLogin(ui, [""]);
		expect(ui.last).toEqual({
			type: "error",
			message: "pika login failed: the server has too many pending pairings; approve or deny them in the web UI, or wait until they expire. Nothing changed.",
		});
		expect(await fileText()).toBe(EXISTING);
		expect(polls()).toBe(0);
	}, 20_000);

	it("gives up when the code is not approved in time", async () => {
		pairingLimits.timeoutMs = 400;
		const ui = new ScriptedUI();
		const started = Date.now();
		await pairLogin(ui, [""]);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(ui.last).toEqual({ type: "error", message: "pika login failed: the code was not approved in time. Nothing changed." });
		expect(polls()).toBeGreaterThan(1);
		expect(await fileText()).toBeUndefined();
		expectNoSecret(ui);
	}, 20_000);

	it("asks again for an invalid device name without contacting the server, takes any other text, and changes nothing when the name prompt is cancelled", async () => {
		const invalid = ["x".repeat(65), "bell\x07", "line\u2028break", "tab\there", "nel\u0085"];
		const name = "  Minhu's MacBook Pro — 2 (naïve) ";
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		const ui = new ScriptedUI();
		await pairLogin(ui, [...invalid, name]);
		const warning = "pika: that name does not work: use 1 to 64 characters, without control characters. Enter another, or press Esc to cancel.";
		expect(ui.notes.filter((note) => note.type === "warning")).toEqual(invalid.map(() => ({ type: "warning", message: warning })));
		expect(ui.prompts).toHaveLength(invalid.length + 1);
		expect(new Set(ui.prompts.map((prompt) => prompt.title))).toEqual(new Set([nameTitle(defaultDeviceName())]));
		expect(ingest.pairRequests.filter((request) => request.path === "start").map((request) => request.body.device)).toEqual([name.trim()]);
		expect(ui.last?.message).toMatch(new RegExp(`^Logged in to ${ingest.url} as Minhu's MacBook Pro — 2 \\(naïve\\); saved`));
		expect(ingest.deviceNamed(name.trim()).token).toBe(JSON.parse((await fileText())!).token);

		const before = ingest.pairRequests.length;
		const cancelled = new ScriptedUI();
		await pairLogin(cancelled, ["x".repeat(65), undefined]);
		expect(cancelled.last?.message).toBe("pika login cancelled. Nothing changed.");
		expect(ingest.pairRequests).toHaveLength(before);
	}, 30_000);

	it("suggests the hostname without a trailing .local, cut to 64 characters", () => {
		expect(defaultDeviceName("Minhu's MacBook Pro.local")).toBe("Minhu's MacBook Pro");
		expect(defaultDeviceName("box.LOCAL")).toBe("box");
		expect(defaultDeviceName("laptop_2.lan")).toBe("laptop_2.lan");
		expect(defaultDeviceName("local.lan")).toBe("local.lan");
		expect(defaultDeviceName(`${"ü".repeat(70)}`)).toBe("ü".repeat(64));
		expect(defaultDeviceName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
		expect(defaultDeviceName(".local")).toBe("pi");
		expect(defaultDeviceName("")).toBe("pi");
		expect(defaultDeviceName("a\x07b")).toBe("pi");
		expect(validDeviceName(defaultDeviceName())).toBe(true);
		for (const valid of ["x", " x ", "x".repeat(64), "🙂".repeat(64), "two words", "naïve"]) expect(validDeviceName(valid), valid).toBe(true);
		for (const invalid of ["", "   ", "x".repeat(65), "a\nb", "a\u0085b", "a\u2029b", "a\x7fb"]) expect(validDeviceName(invalid), JSON.stringify(invalid)).toBe(false);
	});

	it("reports the server's limits on pairing attempts", async () => {
		for (let i = 0; i < 5; i++) {
			const response = await fetch(`${ingest.url}/api/pair/v1/start`, { method: "POST", body: JSON.stringify({ device: `d${i}` }) });
			expect(response.status).toBe(200);
		}
		const ui = new ScriptedUI();
		await pairLogin(ui, [""]);
		expect(ui.last?.message).toMatch(/^pika login failed: too many pairing attempts; try again in \d+ s\. Nothing changed\.$/);
	}, 20_000);

	const networkFailures: { name: string; setup: () => Promise<void> | void; message: () => string }[] = [
		{ name: "an unreachable server", setup: () => ingest.stop(), message: () => `could not reach ${ingest.url}` },
		{ name: "a redirect", setup: () => { ingest.mode = "redirect"; }, message: () => `could not reach ${ingest.url}` },
		{ name: "an error status", setup: () => { ingest.mode = "fail"; }, message: () => `unexpected HTTP 503 from ${ingest.url}` },
	];
	it.each(networkFailures)("changes nothing when starting meets $name", async ({ setup, message }) => {
		await writeFile(configFile(), EXISTING);
		await setup();
		const ui = new ScriptedUI();
		await pairLogin(ui, [""]);
		expect(ui.last).toEqual({ type: "error", message: `pika login failed: ${message()}. Nothing changed.` });
		expect(await fileText()).toBe(EXISTING);
	}, 20_000);

	it("changes nothing when the server goes away while waiting", async () => {
		await writeFile(configFile(), EXISTING);
		const ui = new ScriptedUI();
		ui.choices = [PAIR];
		ui.inputs = [""];
		const h = await session(ui);
		try {
			const running = h.session.prompt(`/pika login ${ingest.url}`);
			await waitFor(() => polls() >= 1, 5_000, "polling");
			await ingest.stop();
			await running;
			expect(ui.last).toEqual({ type: "error", message: `pika login failed: could not reach ${ingest.url}. Nothing changed.` });
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
		expect(await fileText()).toBe(EXISTING);
		expectNoSecret(ui);
	}, 20_000);
});

describe("PairingView", () => {
	it("renders the code, the whole link, and the time left within the width, and cancels on Esc", () => {
		vi.useFakeTimers();
		try {
			const render = vi.fn();
			const cancel = vi.fn();
			const url = "https://homelab.example/pika/devices?pair=ABCD-EFGH";
			const view = new PairingView({ code: "ABCD-EFGH", link: url, deadline: Date.now() + 600_000 }, { requestRender: render }, plainTheme, cancel);
			expect(view.render(80)).toEqual([
				"Pair this machine with pika",
				"Open this page and approve the code:",
				`  ${url}`,
				"Code: ABCD-EFGH",
				"Waiting for approval · expires in 10:00 · Esc cancels",
			]);
			for (const width of [1, 20, 40]) {
				const lines = view.render(width);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			expect(view.render(20).filter((line) => line.startsWith("  ")).map((line) => line.trim()).join("")).toBe(url);
			vi.advanceTimersByTime(61_000);
			expect(render).toHaveBeenCalledTimes(61);
			expect(view.render(80).at(-1)).toBe("Waiting for approval · expires in 8:59 · Esc cancels");
			view.handleInput("a");
			expect(cancel).not.toHaveBeenCalled();
			view.handleInput(ESC);
			expect(cancel).toHaveBeenCalledTimes(1);
			view.dispose();
			vi.advanceTimersByTime(5_000);
			expect(render).toHaveBeenCalledTimes(61);
		} finally { vi.useRealTimers(); }
	});
});

describe("device key", () => {
	const sha = (text: string) => createHash("sha256").update(text).digest("hex");
	// This machine as the OS names it, unless a test says its id is only the hostname fallback.
	let source = { id: "this-machine", fromOs: true };
	const machine = async () => sha(source.id);
	const keyFile = () => deviceKeyFile(workspace.pikaDir);
	const readKeyFile = async () => JSON.parse(await readFile(keyFile(), "utf8")) as { v: number; key: string; machine: string | null };
	beforeEach(() => {
		source = { id: "this-machine", fromOs: true };
		deviceKeyHooks.machine = async () => source;
	});
	afterEach(() => { delete deviceKeyHooks.afterWrite; delete deviceKeyHooks.machine; });

	it("is made once per agent dir with mode 0600, then reused", async () => {
		const key = await deviceKey(workspace.pikaDir);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(await readKeyFile()).toEqual({ v: 1, key, machine: await machine() });
		expect((await stat(keyFile())).mode & 0o777).toBe(0o600);
		expect((await readdir(workspace.pikaDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(await deviceKey(workspace.pikaDir)).toBe(key);
	});

	it("replaces a file copied from another machine, and an invalid one", async () => {
		await mkdir(workspace.pikaDir, { recursive: true });
		const copied = { v: 1, key: "a".repeat(64), machine: "0".repeat(64) };
		await writeFile(keyFile(), JSON.stringify(copied));
		const key = await deviceKey(workspace.pikaDir);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(key).not.toBe(copied.key);
		expect(await readKeyFile()).toEqual({ v: 1, key, machine: await machine() });
		for (const invalid of ["{ not json", "[]", JSON.stringify({ v: 2, key, machine: await machine() }), JSON.stringify({ v: 1, key: "ABC", machine: await machine() })]) {
			await writeFile(keyFile(), invalid);
			const replaced = await deviceKey(workspace.pikaDir);
			expect(replaced).toMatch(/^[0-9a-f]{64}$/);
			expect((await readKeyFile()).key).toBe(replaced);
		}
	});

	it("keeps an existing key while this machine's id is only the hostname fallback", async () => {
		const key = await deviceKey(workspace.pikaDir);
		const made = await readFile(keyFile(), "utf8");
		// The OS's id is not available this time (ioreg failed, for example); the hostname does not prove the file was copied.
		source = { id: "hostname", fromOs: false };
		expect(await deviceKey(workspace.pikaDir)).toBe(key);
		expect(await readFile(keyFile(), "utf8")).toBe(made);
	});

	it("records no fingerprint for a file made with only the fallback, and adopts it once the OS's id is known", async () => {
		source = { id: "hostname", fromOs: false };
		const key = await deviceKey(workspace.pikaDir);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(await readKeyFile()).toEqual({ v: 1, key, machine: null });
		expect(await deviceKey(workspace.pikaDir)).toBe(key);
		expect(await readKeyFile()).toEqual({ v: 1, key, machine: null });

		source = { id: "this-machine", fromOs: true };
		expect(await deviceKey(workspace.pikaDir)).toBe(key);
		expect(await readKeyFile()).toEqual({ v: 1, key, machine: await machine() });
		expect((await stat(keyFile())).mode & 0o777).toBe(0o600);
		expect((await readdir(workspace.pikaDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		// Adopted, it is this machine's: a file made on another machine is still replaced.
		source = { id: "another-machine", fromOs: true };
		expect(await deviceKey(workspace.pikaDir)).not.toBe(key);
	});

	it("uses the file on disk after adopting one, so a process that raced it wins", async () => {
		await mkdir(workspace.pikaDir, { recursive: true });
		await writeFile(keyFile(), JSON.stringify({ v: 1, key: "c".repeat(64), machine: null }));
		const winner = "d".repeat(64);
		deviceKeyHooks.afterWrite = async (file) => { await writeFile(file, JSON.stringify({ v: 1, key: winner, machine: await machine() })); };
		expect(await deviceKey(workspace.pikaDir)).toBe(winner);
	});

	it("uses the key on disk after writing, so of two processes that raced both use the winner's", async () => {
		const winner = "b".repeat(64);
		deviceKeyHooks.afterWrite = async (file) => { await writeFile(file, JSON.stringify({ v: 1, key: winner, machine: await machine() })); };
		expect(await deviceKey(workspace.pikaDir)).toBe(winner);
	});

	it("starts pairing without a key when no key file can be made", async () => {
		// The agent's pika directory is a file, so nothing can be written under it.
		await writeFile(workspace.pikaDir, "");
		expect(await deviceKey(workspace.pikaDir)).toBeUndefined();
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		const ui = new ScriptedUI();
		await pairLogin(ui, ["keyless"]);
		expect(ingest.pairRequests[0]!.body).toEqual({ device: "keyless", host: hostname(), pikaVersion: PIKA_VERSION });
		expect(ui.last?.message).toMatch(new RegExp(`^Logged in to ${ingest.url} as keyless; saved`));
	}, 20_000);
});

describe("re-pairing", () => {
	it("is recognized by the device key, continues the device, and says so", async () => {
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		await pairLogin(new ScriptedUI(), ["first name"]);
		const id = ingest.deviceId("first name");
		const first = ingest.devices.get(id)!.token!;
		// Logged out: no token to send, so only the key recognizes the machine; logout keeps the key file.
		await command(new ScriptedUI(), "/pika logout");
		expect(storedKey()).toMatch(/^[0-9a-f]{64}$/);
		let match: unknown;
		ingest.onPairingStart = (code) => { match = ingest.pendingPairings()[0]!.match; ingest.approve(code, { name: "renamed box" }); };
		const ui = new ScriptedUI();
		await pairLogin(ui, ["requested name"]);
		expect(match).toEqual({ id, by: "key" });
		expect(ingest.pairRequests.at(-2)).toEqual({ path: "start", body: expect.objectContaining({ device: "requested name", key: storedKey() }) });
		expect(ingest.pairRequests.at(-2)!.authorization).toBeUndefined();
		expect([...ingest.devices.keys()]).toEqual([id]);
		const token = ingest.devices.get(id)!.token!;
		expect(token).not.toBe(first);
		expect(ingest.tokens.has(first)).toBe(false);
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token });
		expect(ui.last?.message.split("\n")[0]).toBe(`Logged in to ${ingest.url} as renamed box; saved to ${configFile()}. This continues the existing device.`);
		expectNoSecret(ui);
	}, 30_000);

	it("sends the configured token only to the server it belongs to", async () => {
		const { id, token } = ingest.addDevice("desk");
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		const starts = () => ingest.pairRequests.filter((request) => request.path === "start");

		// pika.json's URL, written differently, is the same server.
		await workspace.configure({ url: `${ingest.url.toUpperCase().replace("/PIKA", "/pika")}//`, token });
		const ui = new ScriptedUI();
		await pairLogin(ui, [""]);
		expect(starts()[0]!.authorization).toBe(`Bearer ${token}`);
		expect(ingest.devices.get(id)!.name).toBe("desk");
		expect(ui.last?.message.split("\n")[0]).toBe(`Logged in to ${ingest.url} as desk; saved to ${configFile()}. This continues the existing device.`);
		expectNoSecret(ui, [token]);

		// PIKA_URL and PIKA_TOKEN count as configured too.
		await workspace.configure(undefined);
		const current = ingest.devices.get(id)!.token!;
		process.env.PIKA_URL = ingest.url;
		process.env.PIKA_TOKEN = current;
		try {
			await pairLogin(new ScriptedUI(), [""]);
		} finally { delete process.env.PIKA_URL; delete process.env.PIKA_TOKEN; }
		expect(starts()[1]!.authorization).toBe(`Bearer ${current}`);

		// A token configured for another server never goes to this one.
		const other = await new MockIngest().reserve();
		await workspace.configure({ url: other.url, token: "token-for-another-server" });
		await pairLogin(new ScriptedUI(), [""]);
		process.env.PIKA_URL = other.url;
		process.env.PIKA_TOKEN = "token-for-another-server";
		try {
			await workspace.configure({ url: ingest.url, token: "token-for-this-server" });
			await pairLogin(new ScriptedUI(), [""]);
		} finally { delete process.env.PIKA_URL; delete process.env.PIKA_TOKEN; }
		expect(starts().slice(2).map((request) => request.authorization)).toEqual([undefined, undefined]);
		expect(ingest.binds.every((bind) => !bind.authorization?.includes("token-for-"))).toBe(true);
	}, 30_000);

	it("reads a pre-0.4 server's approval, which has no name or continued, and explains its name rule on a 400", async () => {
		ingest.legacyNames = true;
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		const ui = new ScriptedUI();
		await pairLogin(ui, ["legacy-box"]);
		expect(ingest.devices.get("legacy-box")).toMatchObject({ name: "legacy-box" });
		expect(ui.last?.message.split("\n")[0]).toBe(`Logged in to ${ingest.url} as legacy-box; saved to ${configFile()}.`);

		const refused = new ScriptedUI();
		await pairLogin(refused, ["two words"]);
		expect(refused.last).toEqual({
			type: "error",
			message: "pika login failed: the server refused the device name; pika servers older than 0.4 accept only letters, digits, '.', '_', and '-'. Nothing changed.",
		});
	}, 30_000);

	it("blames an older server only for refusing a name a 0.4 server accepts", async () => {
		// A 0.4 server refusing a name, and a malformed key; the login never sends either, since it checks the name first.
		expect(await startPairing(ingest.url, "bad\u0007name")).toEqual({ kind: "failed", problem: "the server refused the device name" });
		expect(await startPairing(ingest.url, "fine", undefined, { key: "not-a-key" })).toEqual({ kind: "failed", problem: "the server refused this machine's device key" });
		ingest.legacyNames = true;
		expect(await startPairing(ingest.url, "two words")).toEqual({
			kind: "failed",
			problem: "the server refused the device name; pika servers older than 0.4 accept only letters, digits, '.', '_', and '-'",
		});
		expect(await startPairing(ingest.url, "bad\u0007name")).toEqual({ kind: "failed", problem: "the server refused the device name" });
	});

	it("names the device only by the name asked for when the approval does not say which device it is", async () => {
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		ingest.onPoll = ({ status, body: { token: _token, ...body } }) => ({ status, body: body.status === "approved" ? { ...body, device: "not an id!" } : body });
		const ui = new ScriptedUI();
		await pairLogin(ui, ["asked name"]);
		expect(ui.last).toEqual({
			type: "error",
			message: `pika login failed: the server approved the pairing but sent no token. The pairing created the device asked name on ${ingest.url}, but this machine did not keep its token; revoke asked name on the Devices page (${ingest.url}/devices). ${configFile()} is unchanged.`,
		});
	}, 20_000);

	it("falls back to the id for a name it cannot show, and to a new device when continued is not true", async () => {
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		ingest.onPoll = ({ status, body }) => ({ status, body: body.status === "approved" ? { ...body, name: "bad\u0007name", continued: "yes" } : body });
		const ui = new ScriptedUI();
		await pairLogin(ui, ["shown"]);
		const id = ingest.deviceId("shown");
		expect(ui.last?.message.split("\n")[0]).toBe(`Logged in to ${ingest.url} as ${id}; saved to ${configFile()}.`);
	}, 20_000);

	it("names a continued device in the orphan message and says its previous token stopped", async () => {
		const { id } = ingest.addDevice("old desk");
		await workspace.configure({ url: ingest.url, token: ingest.devices.get(id)!.token, enabled: false });
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		ingest.onPoll = ({ status, body: { token: _token, ...body } }) => ({ status, body });
		const ui = new ScriptedUI();
		await pairLogin(ui, [""]);
		expect(ui.last).toEqual({
			type: "error",
			message: `pika login failed: the server approved the pairing but sent no token. The pairing gave the existing device old desk (${id}) on ${ingest.url} a new token, which stopped its previous one, but this machine did not keep it; run /pika login again, or revoke old desk (${id}) on the Devices page (${ingest.url}/devices). ${configFile()} is unchanged.`,
		});
	}, 20_000);
});

describe("binding the device key", () => {
	const hash = (text: string) => createHash("sha256").update(text).digest("hex");

	it("binds after a pasted-token login, so a later pairing continues that device", async () => {
		const { id, token } = ingest.addDevice("pasted");
		const ui = new ScriptedUI();
		ui.choices = [PASTE];
		ui.inputs = [token];
		// The session stays open until the bind is done: shutting down the process's last session aborts it.
		const h = await session(ui);
		try {
			await h.session.prompt(`/pika login ${ingest.url}`);
			expect(h.errors).toEqual([]);
			await waitFor(() => ingest.binds.length === 1, 5_000, "the bind");
		} finally { await h.shutdown(); }
		expect(ingest.binds[0]).toEqual({ authorization: `Bearer ${token}`, body: { key: storedKey() }, status: 204 });
		expect(ingest.devices.get(id)!.keyHash).toBe(hash(storedKey()!));
		expectNoSecret(ui, [token]);
	}, 20_000);

	it("binds once per process for each URL and token when pika is enabled, and again after each login", async () => {
		const { token } = ingest.addDevice("desk");
		await workspace.configure({ url: ingest.url, token });
		const ui = new ScriptedUI();
		const h = await session(ui);
		try {
			await waitFor(() => ingest.binds.length === 1, 5_000, "the bind");
			const second = await session(new ScriptedUI());
			await second.shutdown();
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(ingest.binds).toHaveLength(1);
			ui.choices = [PASTE];
			ui.inputs = [token];
			await h.session.prompt(`/pika login ${ingest.url}`);
			await waitFor(() => ingest.binds.length === 2, 5_000, "the bind after the login");
			expect(ingest.binds.map((bind) => bind.status)).toEqual([204, 204]);
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
	}, 20_000);

	it("remembers what it bound by a hash of the URL as login writes it and the token, never the token itself", async () => {
		const { token } = ingest.addDevice("desk");
		bindOnce(ingest.url, token, workspace.pikaDir);
		await waitFor(() => ingest.binds.length === 1, 5_000, "the bind");
		// The same server written differently is bound already.
		bindOnce(`${ingest.url}/`, token, workspace.pikaDir);
		bindOnce(ingest.url.replace("http://", "HTTP://"), token, workspace.pikaDir);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(ingest.binds).toHaveLength(1);
		const remembered = [...(globalThis as { [key: symbol]: Set<string> | undefined })[Symbol.for("pi-extensions.pika.bound")]!];
		expect(remembered.length).toBeGreaterThan(0);
		for (const entry of remembered) {
			expect(entry).toMatch(/^[0-9a-f]{64}$/);
			expect(entry).not.toContain(token);
		}
	}, 20_000);

	it("aborts a bind that hangs when the last session shuts down, and binds again in a later session", async () => {
		const { token } = ingest.addDevice("desk");
		await workspace.configure({ url: ingest.url, token });
		ingest.hangBinds = true;
		const h = await session(new ScriptedUI());
		const child = await session(new ScriptedUI());
		await waitFor(() => ingest.hungBinds === 1, 5_000, "the bind");
		// Another session of the process is still open, so the bind goes on.
		await child.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(ingest.closedBinds).toBe(0);
		const started = Date.now();
		await h.shutdown();
		await waitFor(() => ingest.closedBinds === 1, 1_000, "the aborted bind");
		expect(Date.now() - started).toBeLessThan(BIND_TIMEOUT_MS / 2);
		expect(h.errors).toEqual([]);
		ingest.hangBinds = false;
		const later = await session(new ScriptedUI());
		try {
			await waitFor(() => ingest.binds.length === 1, 5_000, "the bind in the later session");
			expect(ingest.binds[0]).toMatchObject({ authorization: `Bearer ${token}`, status: 204 });
		} finally { await later.shutdown(); }
	}, 20_000);

	it("does not keep pi -p alive after its work while a bind hangs", async () => {
		const { token } = ingest.addDevice("desk");
		ingest.hangBinds = true;
		const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
		const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: workspace.agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PIKA_URL: ingest.url, PIKA_TOKEN: token };
		delete env.PIKA_DISABLED;
		const started = Date.now();
		const child = spawn(process.execPath, [
			join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
			"--no-extensions", "-e", join(repo, "extensions", "pika", "index.ts"), "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"-p", "/pika",
		], { cwd: workspace.agentDir, env, stdio: "ignore" });
		try {
			const [code] = await once(child, "exit") as [number | null];
			expect(code).toBe(0);
		} finally { child.kill(); }
		// The bind is aborted at shutdown, sent or not; without that, it would hang and hold the process for BIND_TIMEOUT_MS.
		expect(ingest.hungBinds).toBeLessThanOrEqual(1);
		expect(Date.now() - started).toBeLessThan(BIND_TIMEOUT_MS - 1_000);
	}, 30_000);

	const failures: { name: string; setup: () => Promise<string> | string }[] = [
		{ name: "a server without bind (404)", setup: () => { ingest.legacyNames = true; return ingest.addDevice("old").token; } },
		{ name: "a key another device holds (409)", setup: async () => { ingest.addDevice("holder", { keyHash: hash((await deviceKey(workspace.pikaDir))!) }); return ingest.addDevice("other").token; } },
		{ name: "a token the server rejects (401)", setup: () => "unknown-token" },
		{ name: "an unreachable server", setup: async () => { const token = ingest.addDevice("gone").token; await ingest.stop(); return token; } },
		{ name: "a server that never answers", setup: () => { ingest.mode = "hang"; return ingest.addDevice("slow").token; } },
	];
	it.each(failures)("ignores $name without a message, and never holds up the session", async ({ setup }) => {
		const token = await setup();
		await workspace.configure({ url: ingest.url, token });
		const ui = new ScriptedUI();
		const started = Date.now();
		const h = await session(ui);
		try {
			h.faux.setResponses([fauxAssistantMessage("fine")]);
			await h.session.prompt("hello");
			expect(Date.now() - started).toBeLessThan(3_000);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(ui.notes).toEqual([]);
			expect(h.errors).toEqual([]);
		} finally { await h.shutdown(); }
		expect(storedKey()).toMatch(/^[0-9a-f]{64}$/);
	}, 20_000);
});
