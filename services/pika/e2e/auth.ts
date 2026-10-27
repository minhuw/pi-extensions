// pika's authentication end to end: a new machine pairs through the real extension's `/pika login` under a free-text
// name while the browser denies and then approves its request on the Devices page; after `/pika logout` it pairs again,
// the browser recognizes it by its device key, and approving continues the same device; the Devices page renames it;
// revoking it stops its uploads; signing out retires the browser's session cookie; and the login page's rate limit.
// Run by driver.ts after the viewer and relay checks.
import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ScriptedUI } from "../../../extensions/pika/tests/support/ui.ts";
import { allEntries, devices, type ReadApi, type SessionSummary } from "./api.ts";
import type { Ui } from "./browser.ts";
import { PROMPTS, type Pi } from "./scenario.ts";
import { check, checkEqual, log, waitFor } from "./util.ts";

// The prompts of the contract's `/pika login`. The extension's own constants live in login.ts, which Node's type
// stripping cannot load, so the driver checks the prompts it sees against these.
const METHOD_TITLE = "How should this machine log in?";
const PAIR = "Pair with the pika web UI (recommended)";
const PASTE = "Paste a token";
const URL_TITLE = "pika server URL: the address you open the pika web UI at, e.g. https://pika.example.com or http://192.168.1.10:7171";
const URL_PLACEHOLDER = "https://pika.example.com";
const URL_WARNING = "pika: the server URL must start with http:// or https://. Enter the address you open the pika web UI at, e.g. https://pika.example.com, or press Esc to cancel.";
const NAME_WARNING = "pika: that name does not work: use 1 to 64 characters, without control characters. Enter another, or press Esc to cancel.";
const nameTitle = (suggested: string) => `Name for this machine in pika (any text up to 64 characters; blank uses ${suggested})`;
/** The name pika suggests: this host's name without `.local`, as the extension's `defaultDeviceName` makes it. */
const SUGGESTED = [...hostname().trim().replace(/\.local$/i, "")].slice(0, 64).join("").trim() || "pi";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The server's poll interval is 2 s; approval and denial reach pi within a few polls. */
const DECIDED_MS = 15_000;

/** A machine that has never logged in: its own agent dir without `pika.json`, and pi with a scripted UI. */
export interface NewMachine {
	agentDir: string;
	pi: Pi;
	ui: ScriptedUI;
	/** Tokens and keys that must never appear in anything pika showed. */
	secrets: string[];
}

export interface AuthTargets {
	url: string;
	password: string;
	api: ReadApi;
	/** The device name the new machine asks for. */
	device: string;
	/** The name the Devices page renames it to. */
	renamed: string;
}

/** The device the machine paired as. */
export interface Paired { id: string; token: string; sessionId: string }

const configFile = (machine: NewMachine) => join(machine.agentDir, "pika.json");
const keyFile = (machine: NewMachine) => join(machine.agentDir, "pika", "device-key.json");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Starts `/pika login` on the new machine, choosing pairing, and returns the code and approval page from the
 * notification pika shows outside the TUI, with the command's promise. `inputs` answers the prompts (the URL ones
 * only without `arg`); pika pairs as `name`.
 */
async function startPairing(machine: NewMachine, t: AuthTargets, login: { arg?: string; inputs: string[]; name: string }): Promise<{ code: string; link: string; command: Promise<void> }> {
	const { ui, pi } = machine;
	const notes = ui.notes.length;
	ui.choices = [PAIR];
	ui.inputs = [...login.inputs];
	const command = pi.session.prompt(login.arg ? `/pika login ${login.arg}` : "/pika login");
	// A failure before the code shows would otherwise only surface as a timeout.
	command.catch(() => {});
	const pattern = new RegExp(`^To pair this machine with pika as ${escapeRegExp(login.name)}, open (\\S+) and approve the code (\\S+)\\. The code expires in 10 minutes; waiting for approval…$`);
	const match = await waitFor(() => ui.notes.slice(notes).map((note) => pattern.exec(note.message)).find(Boolean) ?? false, 10_000, "pika to show the pairing code")
		.catch((error: Error) => { throw new Error(`${error.message}; pika showed ${JSON.stringify(ui.notes.slice(notes))}`); });
	const [link, code] = [match[1]!, match[2]!];
	checkEqual(link, `${t.url}/devices?pair=${encodeURIComponent(code)}`, "the approval page pika shows");
	check(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code), `the pairing code ${code} is not XXXX-XXXX from the code alphabet`);
	checkEqual(ui.selects.at(-1), { title: METHOD_TITLE, options: [PAIR, PASTE] }, "the login method prompt");
	checkEqual(ui.prompts.at(-1), { title: nameTitle(SUGGESTED), placeholder: SUGGESTED }, "the device name prompt");
	checkEqual(ui.inputs, [], "prompts pika did not ask");
	return { code, link, command };
}

/** The device a pairing request is recognized as, as the approval page should show it. */
interface Recognized { id: string; name: string; active: boolean }

/**
 * Opens the approval page the way the user would, and checks the request is highlighted with nothing edited: a new
 * device proposes the requested name, a recognized one its own name. With `shot`, screenshots the card in both themes.
 */
async function openRequest(browser: Ui, code: string, link: string, request: { name: string; recognized?: Recognized; shot?: string }): Promise<string> {
	await browser.page.goto(link, { waitUntil: "networkidle0" });
	const card = `[data-pairing="${code}"]`;
	await browser.visible(`${card}[data-highlighted]`);
	checkEqual(await browser.count("[data-pairing][data-highlighted]"), 1, "highlighted pairing requests");
	const text = await browser.textOf(card);
	check(text.includes(code) && /Expires in \d+:\d\d/.test(text), `the pairing request shows ${JSON.stringify(text)}`);
	checkEqual(await browser.textOf(`${card} [data-pairing-name]`), `Requested name ${request.name}`, "the requested name on the approval page");
	const { recognized } = request;
	const proposed = await browser.page.$eval(`${card} input:not([type=radio])`, (input) => (input as HTMLInputElement).value);
	checkEqual(proposed, recognized?.name ?? request.name, "the device name the approval page proposes");
	if (recognized) {
		checkEqual(await browser.page.$eval(card, (node) => node.getAttribute("data-pairing-match")), recognized.id, "the device the approval page recognized");
		checkEqual(await browser.textOf(`${card} [data-pairing-recognized="key"]`), `Recognized as ${recognized.name} by its device key`, "the recognition callout");
		const chosen = await browser.page.$eval(`${card} input[type=radio]:checked`, (input) => (input.closest("label") as HTMLElement).innerText);
		checkEqual(chosen, `Continue ${recognized.name}\n${recognized.active ? "Same history; its current token stops working." : "Same history."}`, "the approval page's default choice");
	} else {
		check(!(await browser.count(`${card}[data-pairing-match], ${card} [data-pairing-recognized]`)), "the approval page recognized a new machine");
		check((await browser.textOf(`${card} [data-pairing-new]`)).includes("Approves a new device."), "the approval page does not approve a new device by default");
	}
	if (request.shot) {
		const theme = browser.theme;
		for (const each of [theme, theme === "dark" ? "light" : "dark"] as const) {
			await browser.setTheme(each);
			await browser.shot(request.shot);
		}
		await browser.setTheme(theme);
	}
	return card;
}

/** The browser denies the first request: pi reports it and nothing changes on the machine or the server. */
export async function checkDeniedPairing(browser: Ui, machine: NewMachine, t: AuthTargets): Promise<void> {
	const { code, link, command } = await startPairing(machine, t, { arg: t.url, inputs: [t.device], name: t.device });
	const card = await openRequest(browser, code, link, { name: t.device });
	await browser.click(`${card} button::-p-text(Deny)`);
	await browser.visible("[data-notice=green]");
	checkEqual(await browser.textOf("[data-notice=green]"), `Denied the request from ${t.device}.`, "the notice after denying");
	await waitFor(async () => (await browser.count(card)) === 0, 5_000, "the denied request to leave the page");
	await withTimeout(command, DECIDED_MS, "/pika login to end after the denial");
	checkEqual(machine.ui.last, { type: "error", message: "pika login failed: the pairing was denied in the pika web UI. Nothing changed." }, "pika's message after the denial");
	check(!existsSync(configFile(machine)), "a denied pairing wrote pika.json");
	checkEqual((await t.api.get<{ items: unknown[] }>("pairings"))?.items, [], "pending pairings after the denial");
	check(!(await devices(t.api)).some((device) => device.name === t.device), "a denied pairing created a device");
	browser.noProblems("while denying a pairing request");
	log(`pairing: denied ${code} in the browser; pi reported it and saved nothing`);
}

/** pika.json after a login: owner-only, with the server URL and a new token, which it returns. */
function savedToken(machine: NewMachine, t: AuthTargets): string {
	const file = configFile(machine);
	checkEqual(statSync(file).mode & 0o777, 0o600, "the mode of pika.json after pairing");
	const saved = JSON.parse(readFileSync(file, "utf8")) as { url?: string; token?: string };
	check(typeof saved.token === "string" && /^pika_[0-9a-f]{64}$/.test(saved.token), "pika.json holds no device token after pairing");
	checkEqual(saved.url, t.url, "the server URL in pika.json");
	check(!machine.secrets.includes(saved.token), "pairing handed out a token pika handed out before");
	machine.secrets.push(saved.token);
	return saved.token;
}

/** This install's device key file: owner-only, made on this machine; returns the key. */
function savedKey(machine: NewMachine): string {
	const file = keyFile(machine);
	checkEqual(statSync(file).mode & 0o777, 0o600, "the mode of device-key.json");
	const saved = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; key?: unknown; machine?: unknown };
	check(saved.v === 1 && typeof saved.key === "string" && /^[0-9a-f]{64}$/.test(saved.key) && typeof saved.machine === "string" && /^[0-9a-f]{64}$/.test(saved.machine),
		`device-key.json holds ${JSON.stringify(Object.keys(saved))} instead of v, key, and machine`);
	return saved.key;
}

/** The id a device row shows (its first 8 characters) and the whole id its `data-device-id` and title hold, when they agree. */
async function deviceIdShown(browser: Ui, row: string): Promise<{ text: string; full: string }> {
	const [text, full, title] = await browser.page.$eval(`${row} [data-device-id]`, (node) => [(node as HTMLElement).innerText, node.getAttribute("data-device-id") ?? "", node.getAttribute("title") ?? ""]);
	checkEqual(title, full, "the title of a device row's id");
	return { text: text!, full: full! };
}

/** The session that ran `/pika login` uploads `prompt`'s entries at once, attributed to `id`; returns its summary. */
async function uploads(machine: NewMachine, t: AuthTargets, prompt: string, id: string): Promise<SessionSummary> {
	await machine.pi.prompt(prompt);
	const sessionId = machine.pi.session.sessionId;
	const lines = () => readFileSync(machine.pi.session.sessionFile!, "utf8").split("\n").filter(Boolean).length;
	await waitFor(async () => ((await allEntries(t.api, sessionId))?.length ?? 0) === lines() || undefined, 10_000, "the paired machine's session to upload");
	const summary = await t.api.get<SessionSummary>(`sessions/${sessionId}`);
	check(summary, `the read API does not have session ${sessionId}`);
	checkEqual(summary.device, id, "the device the paired machine's session is attributed to");
	return summary;
}

/**
 * The browser approves the second request unchanged: the server makes a new device with a UUID id and the requested
 * name, pi saves the token like a pasted one, owner-only, and the session uploads at once, attributed to that id.
 */
export async function checkApprovedPairing(browser: Ui, machine: NewMachine, t: AuthTargets): Promise<Paired> {
	const { code, link, command } = await startPairing(machine, t, { arg: t.url, inputs: [t.device], name: t.device });
	const card = await openRequest(browser, code, link, { name: t.device, shot: "16-devices-pairing" });
	await browser.click(`${card} button[aria-label="Approve ${code}"]`);
	await browser.visible("[data-notice=green]");
	checkEqual(await browser.textOf("[data-notice=green]"), `Approved ${t.device}.`, "the notice after approving");
	await withTimeout(command, DECIDED_MS, "/pika login to finish after the approval");
	const file = configFile(machine);
	const last = machine.ui.last;
	check(last?.type === "info" && last.message.startsWith(`Logged in to ${t.url} as ${t.device}; saved to ${file}.\n`) && last.message.includes(`This session now uploads to ${t.url}.`),
		`pika's message after the approval: ${JSON.stringify(last)}`);
	const token = savedToken(machine, t);
	machine.secrets.push(savedKey(machine));
	checkEqual((await t.api.get<{ items: unknown[] }>("pairings"))?.items, [], "pending pairings after the approval");

	const named = (await devices(t.api)).filter((item) => item.name === t.device);
	checkEqual(named.length, 1, `devices named ${t.device}`);
	const id = named[0]!.id;
	check(UUID.test(id), `the paired device's id ${id} is not a UUID v4`);
	const summary = await uploads(machine, t, PROMPTS.paired, id);
	checkEqual(summary.deviceName, t.device, "the device name of the paired machine's session");
	const device = (await devices(t.api)).find((item) => item.id === id);
	checkEqual({ name: device?.name, createdVia: device?.createdVia, seen: typeof device?.lastSeenAt === "string", hasKey: device?.hasKey },
		{ name: t.device, createdVia: "pairing", seen: true, hasKey: true }, `the paired device ${id}`);
	// The page lists the new device under its name, with its id. The device exists once pi polled, after the page
	// refreshed its list on approving; the page keeps refetching after an approval, so it shows without a reload.
	const row = `[data-device="${id}"]`;
	await browser.visible(row);
	checkEqual(await browser.textOf(`${row} [data-device-label]`), t.device, "the paired device's row");
	checkEqual(await deviceIdShown(browser, row), { text: `${id.slice(0, 8)}…`, full: id }, "the id the paired device's row shows");
	noSecrets(machine);
	browser.noProblems("while approving a pairing request");
	log(`pairing: approved ${code} as ${id} (${t.device}); pika.json is 0600 and session ${summary.id} uploads as it`);
	return { id, token, sessionId: summary.id };
}

/**
 * `/pika logout` keeps the device key; `/pika login` without a URL asks for it again (a URL without a scheme is
 * refused, then asked again; an invalid name likewise; blank takes the suggestion). The approval page recognizes the
 * request by its device key, and approving it unchanged continues the device: same id and name, a new token, the old
 * one refused, and the session keeps uploading as that device.
 */
export async function checkRepairing(browser: Ui, machine: NewMachine, t: AuthTargets, paired: Paired): Promise<Paired> {
	const { ui } = machine;
	const key = savedKey(machine);
	await machine.pi.session.prompt("/pika logout");
	check(ui.last?.message.startsWith(`Logged out of pika: removed the url and token from ${configFile(machine)}.`), `/pika logout said ${JSON.stringify(ui.last)}`);
	checkEqual(JSON.parse(readFileSync(configFile(machine), "utf8")), {}, "pika.json after /pika logout");
	checkEqual(savedKey(machine), key, "the device key after /pika logout");

	const notes = ui.notes.length;
	const prompts = ui.prompts.length;
	const { code, link, command } = await startPairing(machine, t, { inputs: ["localhost:7171", t.url, "bad\u0007name", ""], name: SUGGESTED });
	checkEqual(ui.prompts.slice(prompts), [
		{ title: URL_TITLE, placeholder: URL_PLACEHOLDER }, { title: URL_TITLE, placeholder: URL_PLACEHOLDER },
		{ title: nameTitle(SUGGESTED), placeholder: SUGGESTED }, { title: nameTitle(SUGGESTED), placeholder: SUGGESTED },
	], "the prompts of /pika login without a URL");
	checkEqual(ui.notes.slice(notes, notes + 2), [{ message: URL_WARNING, type: "warning" }, { message: NAME_WARNING, type: "warning" }], "the warnings for a URL without a scheme and an invalid name");

	const card = await openRequest(browser, code, link, { name: SUGGESTED, recognized: { id: paired.id, name: t.device, active: true }, shot: "22-devices-pairing-recognized" });
	await browser.click(`${card} button[aria-label="Approve ${code}"]`);
	await browser.visible("[data-notice=green]");
	checkEqual(await browser.textOf("[data-notice=green]"), `Approved ${t.device}; it continues the existing device.`, "the notice after approving a recognized machine");
	await withTimeout(command, DECIDED_MS, "/pika login to finish after approving the recognized machine");
	const last = ui.last;
	// The message's "continues" comes from the poll's `continued`.
	check(last?.type === "info" && last.message.startsWith(`Logged in to ${t.url} as ${t.device}; saved to ${configFile(machine)}. This continues the existing device.\n`)
		&& last.message.includes(`This session now uploads to ${t.url}.`), `pika's message after continuing the device: ${JSON.stringify(last)}`);
	const token = savedToken(machine, t);
	checkEqual(savedKey(machine), key, "the device key after pairing again");

	const ingest = await fetch(`${t.url}/api/ingest/v1/batch`, {
		method: "POST", headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json" }, body: JSON.stringify({ client: { host: "e2e" } }),
	});
	checkEqual(ingest.status, 401, "ingest with the token the continued device had before");
	checkEqual((await devices(t.api)).filter((item) => item.id === paired.id || item.name === t.device || item.name === SUGGESTED).map((item) => [item.id, item.name, item.hasKey]),
		[[paired.id, t.device, true]], "the devices after continuing one");
	const summary = await uploads(machine, t, PROMPTS.continued, paired.id);
	checkEqual({ id: summary.id, deviceName: summary.deviceName }, { id: paired.sessionId, deviceName: t.device }, "the continued machine's session");
	await waitFor(async () => (await browser.count(`[data-device="${paired.id}"]`)) === 1, 5_000, "the Devices page to list the continued device once");
	noSecrets(machine);
	browser.noProblems("while approving a recognized machine");
	log(`pairing: after /pika logout, ${code} was recognized by its device key and continued ${paired.id}; the old token is refused`);
	return { ...paired, token };
}

/** Renaming the device on the Devices page changes its name everywhere it is shown, but not its id. */
export async function checkRename(browser: Ui, t: AuthTargets, paired: Paired): Promise<void> {
	await browser.go("/devices");
	const row = `[data-device="${paired.id}"]`;
	const dialog = "[data-dialog=rename]";
	const open = async () => {
		await browser.click(`${row} button[aria-label^="Rename"]`);
		await browser.visible(`${dialog} input`);
		checkEqual(await browser.page.$eval(`${dialog} input`, (input) => (input as HTMLInputElement).value), t.device, "the name the rename dialog starts with");
		check((await browser.textOf(dialog)).includes(`Rename ${t.device}`), "the rename dialog does not name the device");
		await browser.page.$eval(`${dialog} input`, (input) => (input as HTMLInputElement).select());
		await browser.page.type(`${dialog} input`, t.renamed);
	};
	// The dialog is modal, so the theme changes with it closed; Cancel keeps the old name.
	const theme = browser.theme;
	for (const each of [theme === "dark" ? "light" : "dark", theme] as const) {
		await browser.setTheme(each);
		await open();
		await browser.shot("23-devices-rename");
		if (each !== theme) {
			await browser.click(`${dialog} button::-p-text(Cancel)`);
			await browser.page.waitForSelector(dialog, { hidden: true });
		}
	}
	await browser.click(`${dialog} button[type=submit]`);
	await browser.visible("[data-notice=green]");
	checkEqual(await browser.textOf("[data-notice=green]"), `Renamed ${t.device} to ${t.renamed}.`, "the notice after renaming");
	await browser.page.waitForSelector(dialog, { hidden: true });
	checkEqual([await browser.textOf(`${row} [data-device-label]`), (await deviceIdShown(browser, row)).full], [t.renamed, paired.id], "the renamed device's row");
	checkEqual((await devices(t.api)).find((item) => item.id === paired.id)?.name, t.renamed, "the renamed device in the API");
	checkEqual((await t.api.get<SessionSummary>(`sessions/${paired.sessionId}`))?.deviceName, t.renamed, "the device name of the renamed device's session");

	await browser.go("/");
	const label = `[data-session-row="${paired.sessionId}"] [data-device-label="${paired.id}"]`;
	await browser.visible(label);
	checkEqual(await browser.textOf(label), t.renamed, "the device the session list names for the renamed device's session");
	browser.noProblems("while renaming a device");
	log(`devices: renamed ${paired.id} from ${t.device} to ${t.renamed}; the session list shows the new name`);
}

/**
 * The Devices page lists the paired device with its last-seen time, in both themes; revoking it there makes the
 * server refuse its token at once, and the machine's uploader stops with a 401.
 */
export async function checkDevices(browser: Ui, machine: NewMachine, t: AuthTargets, paired: Paired): Promise<void> {
	await browser.go("/devices");
	const row = `[data-device="${paired.id}"]`;
	await browser.visible(row);
	const cells = await browser.page.$$eval(`${row} td`, (nodes) => nodes.map((node) => (node as HTMLElement).innerText.trim()));
	check(cells[1]?.includes("paired"), `the device row's Added cell is ${JSON.stringify(cells[1])}`);
	check(cells[2] && cells[2] !== "never" && /just now|ago|second|minute/.test(cells[2]), `the device row's Last seen cell is ${JSON.stringify(cells[2])}`);
	check(cells[3] && cells[3] !== "—", `the device row's Last host cell is ${JSON.stringify(cells[3])}`);
	await browser.visible("[data-browser-sessions] ::-p-text(This browser)");
	for (const theme of [browser.theme, browser.theme === "dark" ? "light" : "dark"] as const) {
		await browser.setTheme(theme);
		await browser.shot("17-devices");
	}

	await browser.click(`${row} button[aria-label^="Revoke"]`);
	check((await browser.textOf("[role=dialog]")).includes(`Revoke ${t.renamed}?`), "the revoke confirmation does not name the device");
	await browser.click("[role=dialog] button::-p-text(Revoke)");
	await browser.visible("[data-notice=green]");
	checkEqual(await browser.textOf("[data-notice=green]"), `Revoked ${t.renamed}.`, "the notice after revoking");
	await waitFor(async () => (await browser.count(row)) === 0, 5_000, "the revoked device to leave the list");
	check(!(await devices(t.api)).some((item) => item.id === paired.id), "the revoked device is still listed by the API");

	const ingest = await fetch(`${t.url}/api/ingest/v1/batch`, {
		method: "POST", headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json" }, body: JSON.stringify({ client: { host: "e2e" } }),
	});
	checkEqual(ingest.status, 401, "ingest with the revoked token");
	await machine.pi.prompt(PROMPTS.revoked);
	let shown = "";
	const status = await waitFor(async () => {
		await machine.pi.session.prompt("/pika");
		shown = machine.ui.last?.message ?? "";
		return /^Last error: \S+ the server rejected the token \(401\)/m.test(shown) ? shown : undefined;
	}, 15_000, "/pika to report that the server rejected the revoked token", 250).catch((error: Error) => { throw new Error(`${error.message}; /pika says:\n${shown}`); });
	check(status.includes("Stopped: the server rejected the token (401)"), `/pika after the revocation:\n${status}`);
	noSecrets(machine);
	browser.noProblems("on the Devices page");
	log(`devices: ${t.renamed} last seen ${cells[2]}; after revoking it, ingest answers 401 and /pika reports the uploader stopped`);
}

async function browserCookie(browser: Ui, t: AuthTargets): Promise<string> {
	const cookies = await browser.browser.cookies();
	const cookie = cookies.find((item) => item.name === "pika_session");
	check(cookie, `the browser holds no pika_session cookie: ${JSON.stringify(cookies.map((item) => item.name))}`);
	check(cookie.httpOnly && cookie.sameSite === "Lax" && cookie.path === `${new URL(t.url).pathname.replace(/\/$/, "")}/`,
		`the session cookie's attributes: ${JSON.stringify({ httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, path: cookie.path })}`);
	return `pika_session=${cookie.value}`;
}

const status = async (url: string, cookie: string) => (await fetch(`${url}/api/v1/facets`, { headers: { cookie } })).status;

/**
 * The Devices page stops polling pending pairings when signing out starts, but a poll already in flight can reach the
 * server after the session ends and get a 401.
 */
const racingPoll = (browser: Ui) => browser.expect({ status: 401, method: "GET", path: "/api/v1/pairings", atMost: true });

/** Waits until the browser shows the login page. */
async function onLoginPage(browser: Ui, label: string): Promise<void> {
	await browser.visible("#pika-password");
	check(new URL(browser.page.url()).pathname.endsWith("/login"), `${label} leaves the browser at ${browser.page.url()} instead of the login page`);
}

/**
 * `auth/sessions` lists the browser's session; signing out in the sidebar retires its cookie; signing in again and
 * signing out everywhere retires every session, the driver's included. The browser ends on the login page.
 */
export async function checkBrowserSessions(browser: Ui, t: AuthTargets): Promise<void> {
	await browser.go("/devices");
	const first = await browserCookie(browser, t);
	type Item = { id: string; userAgent?: string; ip?: string; current: boolean };
	const listed = await (await fetch(`${t.url}/api/v1/auth/sessions`, { headers: { cookie: first } })).json() as { items: Item[] };
	const current = listed.items.filter((item) => item.current);
	checkEqual(current.length, 1, "current sessions in auth/sessions");
	check(current[0]!.userAgent?.includes("Chrome") && current[0]!.ip === "127.0.0.1", `the browser's session: ${JSON.stringify(current[0])}`);
	check(listed.items.length >= 2, "auth/sessions does not list the driver's session next to the browser's");
	check((await browser.textOf(`[data-browser-session="${current[0]!.id}"]`)).includes("This browser"), "the Devices page does not mark this browser's session");

	const poll = racingPoll(browser);
	await browser.click("aside[aria-label=Sidebar] button::-p-text(Sign out)");
	await onLoginPage(browser, "signing out");
	await poll.done();
	checkEqual(await status(t.url, first), 401, "a read route with the cookie of a signed-out browser");
	const remaining = (await t.api.get<{ items: Item[] }>("auth/sessions"))?.items ?? [];
	check(!remaining.some((item) => item.id === current[0]!.id), "auth/sessions still lists the signed-out browser");
	log("sessions: signing out retires the browser's cookie");

	// A signed-out browser that opens an approval link signs in and lands back on it.
	const stale = "ABCD-2345";
	await browser.go(`/devices?pair=${stale}`);
	await onLoginPage(browser, "opening an approval link signed out");
	checkEqual(new URL(browser.page.url()).searchParams.get("next"), `/devices?pair=${stale}`, "the login page's next path");
	await browser.page.type("#pika-password", t.password);
	await browser.click("button[type=submit]");
	await browser.visible("[data-pairing-missing]");
	const landed = new URL(browser.page.url());
	check(landed.pathname.endsWith("/devices") && landed.searchParams.get("pair") === stale, `signing in from the approval link lands at ${browser.page.url()}`);
	check((await browser.textOf("[data-pairing-missing]")).includes(`No pending request with code ${stale}`), "the approval page does not report the unknown code");
	const second = await browserCookie(browser, t);
	check(second !== first, "signing in again reused the retired session");
	log("sessions: an approval link opened signed out returns there after signing in");
	await browser.go("/devices");
	await browser.click("button::-p-text(Sign out everywhere)");
	const everywherePoll = racingPoll(browser);
	await browser.click("[role=dialog] button::-p-text(Sign out everywhere)");
	await onLoginPage(browser, "signing out everywhere");
	await everywherePoll.done();
	checkEqual(await status(t.url, second), 401, "a read route with the browser's cookie after signing out everywhere");
	checkEqual((await t.api.raw("facets")).status, 401, "a read route with the driver's cookie after signing out everywhere");
	browser.noProblems("while signing out");
	log("sessions: signing out everywhere retires every session; the browser is on the login page");
}

/**
 * Five wrong passwords on the login page show "Wrong password"; the sixth attempt shows "Too many attempts" and the
 * server refuses even the right password from this address. Run last: loopback has one client IP.
 */
export async function checkLoginRateLimit(browser: Ui, t: AuthTargets): Promise<void> {
	await onLoginPage(browser, "the rate limit check");
	const alert = () => browser.page.$eval("[role=alert]", (node) => (node as HTMLElement).innerText).catch(() => undefined);
	const submitAndWait = async (want: (text: string) => boolean, label: string) => {
		await browser.page.click("button[type=submit]");
		return waitFor(async () => {
			const text = await alert();
			const idle = await browser.page.$eval("button[type=submit]", (node) => (node as HTMLButtonElement).innerText === "Continue");
			return idle && text !== undefined && want(text) ? text : undefined;
		}, 10_000, label);
	};
	await browser.page.type("#pika-password", `wrong-${t.password}`);
	const wrong = browser.expect({ status: 401, method: "POST", path: "/api/v1/login", count: 5 });
	for (let attempt = 1; attempt <= 5; attempt++) await submitAndWait((text) => text === "Wrong password", `"Wrong password" after attempt ${attempt}`);
	await wrong.done();
	const limited = browser.expect({ status: 429, method: "POST", path: "/api/v1/login" });
	const message = await submitAndWait((text) => text.startsWith("Too many attempts"), "\"Too many attempts\" after the sixth attempt");
	await limited.done();
	check(/^Too many attempts\. Try again in .+\.$/.test(message), `the rate-limited login page says ${JSON.stringify(message)}`);
	await browser.shot("18-login-rate-limited");
	const right = await fetch(`${t.url}/api/v1/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: t.password }) });
	checkEqual(right.status, 429, "the right password while this address is rate limited");
	check(Number(right.headers.get("retry-after")) > 0, "the 429 has no Retry-After header");
	browser.noProblems("on the rate-limited login page");
	log(`rate limit: 5 wrong passwords, then the login page says ${JSON.stringify(message)}`);
}

/** No token pika handed out or saved appears in anything it showed or asked. */
function noSecrets(machine: NewMachine): void {
	const texts = [...machine.ui.messages, ...machine.ui.prompts.map((prompt) => `${prompt.title} ${prompt.placeholder ?? ""}`)];
	for (const secret of machine.secrets) check(!texts.some((text) => text.includes(secret)), "pika showed a device token");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${label}`)), ms); });
	try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}
