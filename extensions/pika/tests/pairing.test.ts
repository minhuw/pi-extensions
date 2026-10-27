import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "../config.ts";
import pikaExtension, { statusText } from "../index.ts";
import { login, PAIR, PASTE } from "../login.ts";
import { defaultDeviceName, PairingView, pairingLimits } from "../pairing.ts";
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

/** No pairing secret or token in anything pika showed, asked, or would show in `/pika`. */
function expectNoSecret(ui: ScriptedUI, extra: string[] = []): void {
	const texts = [
		...ui.messages, ...ui.prompts.map((prompt) => `${prompt.title} ${prompt.placeholder ?? ""}`), ...ui.rendered,
		statusText(loadConfig(workspace.agentDir), true, undefined, undefined), currentUploader()?.status().lastError ?? "",
	];
	const secrets = [...ingest.pairingIds, ...[...ingest.devices.values()].map((device) => device.token), ...extra];
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
			expect(ingest.pairRequests[0]).toEqual({ path: "start", body: { device, host: hostname(), pikaVersion: PIKA_VERSION } });
			await waitFor(() => ui.messages.some((message) => message.includes(link(pending!.code))), 5_000, "the approval link");
			expect(ui.last).toEqual({
				type: "info",
				message: `To pair this machine with pika as ${device}, open ${link(pending!.code)} and approve the code ${pending!.code}. The code expires in 10 minutes; waiting for approval…`,
			});
			expect(ingest.approve(pending!.code.toLowerCase().replace("-", ""))).toBe(200);
			await running;

			const token = ingest.devices.get(device)!.token;
			expect(token).toMatch(/^pika_/);
			expect(JSON.parse((await fileText())!)).toEqual({ exclude: ["/nowhere"], url: ingest.url, token });
			expect((await stat(configFile())).mode & 0o777).toBe(0o600);
			expect(ui.selects).toEqual([{ title: "How should this machine log in?", options: [PAIR, PASTE] }]);
			expect(ui.prompts).toEqual([{ title: `Device name for this machine (blank uses ${device})`, placeholder: device }]);
			expect(ui.last).toMatchObject({ type: "info", message: expect.stringContaining(`Logged in to ${ingest.url} as ${device}; saved to ${configFile()}.`) });
			expect(ui.last!.message).toMatch(/This session now uploads/);
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
		const token = ingest.devices.get("my-laptop")!.token;
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
		await pairLogin(ui, ["", TOKEN]);
		expect(ui.messages).toContain(`${ingest.url} cannot pair devices: it is a pika server older than 0.2. Paste a token from \`pika token create ${defaultDeviceName()}\` instead.`);
		expect(ui.prompts[1]!.title).toBe(`pika token for ${ingest.url} (pika cannot mask it in this client)`);
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token: TOKEN });
		expect(ui.last).toMatchObject({ type: "info", message: expect.stringContaining(`Logged in to ${ingest.url}; saved`) });
		expectNoSecret(ui, [TOKEN]);
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
			expect([...ingest.devices.keys()]).toEqual(["second-box"]);
			const token = ingest.devices.get("second-box")!.token;
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
		expect(JSON.parse((await fileText())!)).toMatchObject({ url: ingest.url, token: ingest.devices.get("next-box")!.token });
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
			expect(ingest.devices.has("race-box")).toBe(true);
			expect(ui.notes).toContainEqual({
				type: "error",
				message: `pika login cancelled: /pika logout ran. The pairing created the device race-box on ${ingest.url}, but this machine did not keep its token; revoke race-box on the Devices page (${ingest.url}/devices). ${configFile()} is unchanged.`,
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
		expect(saved).toEqual({ url: ingest.url, file: configFile(), reenabled: false, device: "kept-box" });
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token: ingest.devices.get("kept-box")!.token });
		expectNoSecret(ui);
	}, 20_000);

	it("names the device it created when the approved token fails validation, and saves nothing", async () => {
		await writeFile(configFile(), EXISTING);
		ingest.onPairingStart = (code) => { ingest.approve(code); };
		// Like a proxy that leaves /api/pair/ open but blocks /api/ingest/.
		ingest.onPoll = (answer) => { if (answer.body.status === "approved") ingest.mode = "fail"; return answer; };
		const ui = new ScriptedUI();
		await pairLogin(ui, ["proxied-box"]);
		expect(ingest.devices.has("proxied-box")).toBe(true);
		expect(ui.last).toEqual({
			type: "error",
			message: `pika login failed: unexpected HTTP 503 from ${ingest.url}. The pairing created the device proxied-box on ${ingest.url}, but this machine did not keep its token; revoke proxied-box on the Devices page (${ingest.url}/devices). ${configFile()} is unchanged.`,
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
		expect(ui.last).toEqual({
			type: "error",
			message: `pika login failed: the server approved the pairing but sent no token. The pairing created the device tokenless on ${ingest.url}, but this machine did not keep its token; revoke tokenless on the Devices page (${ingest.url}/devices). ${configFile()} is unchanged.`,
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
		expect(JSON.parse((await fileText())!)).toEqual({ url: ingest.url, token: ingest.devices.get("flaky-box")!.token });
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

	it("refuses an invalid device name before contacting the server, and changes nothing when the name prompt is cancelled", async () => {
		for (const name of ["two words", "x".repeat(65), "naïve", "a/b"]) {
			const ui = new ScriptedUI();
			await pairLogin(ui, [name]);
			expect(ui.last).toEqual({ type: "error", message: "pika login failed: the device name must be 1 to 64 letters, digits, '.', '_', or '-'. Nothing changed." });
		}
		const cancelled = new ScriptedUI();
		await pairLogin(cancelled, [undefined]);
		expect(cancelled.last?.message).toBe("pika login cancelled. Nothing changed.");
		expect(ingest.pairRequests).toEqual([]);
		expect(await fileText()).toBeUndefined();
	}, 30_000);

	it("suggests the hostname sanitized to a valid device name", () => {
		expect(defaultDeviceName("Minhu's MacBook Pro.local")).toBe("Minhu-s-MacBook-Pro.local");
		expect(defaultDeviceName("laptop_2.lan")).toBe("laptop_2.lan");
		expect(defaultDeviceName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
		expect(defaultDeviceName("ü")).toBe("pi");
		expect(defaultDeviceName()).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
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
