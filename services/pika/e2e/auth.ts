// pika 0.2's authentication end to end: a new machine pairs through the real extension's `/pika login` while the
// browser denies and then approves its request on the Devices page; revoking the device stops its uploads; signing
// out retires the browser's session cookie; and the login page's rate limit. Run by driver.ts after the viewer checks.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ScriptedUI } from "../../../extensions/pika/tests/support/ui.ts";
import { allEntries, type ReadApi, type SessionSummary } from "./api.ts";
import type { Ui } from "./browser.ts";
import { PROMPTS, type Pi } from "./scenario.ts";
import { check, checkEqual, log, waitFor } from "./util.ts";

// The method prompt of the contract's `/pika login`. The extension's own constants live in login.ts, which Node's type
// stripping cannot load, so the driver checks the prompt it sees against these.
const METHOD_TITLE = "How should this machine log in?";
const PAIR = "Pair with the pika web UI (recommended)";
const PASTE = "Paste a token";
/** The server's poll interval is 2 s; approval and denial reach pi within a few polls. */
const DECIDED_MS = 15_000;

/** A machine that has never logged in: its own agent dir without `pika.json`, and pi with a scripted UI. */
export interface NewMachine {
	agentDir: string;
	pi: Pi;
	ui: ScriptedUI;
	/** Tokens that must never appear in anything pika showed. */
	secrets: string[];
}

export interface AuthTargets {
	url: string;
	password: string;
	api: ReadApi;
	/** The device name the new machine asks for. */
	device: string;
}

const configFile = (machine: NewMachine) => join(machine.agentDir, "pika.json");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Starts `/pika login <url>` on the new machine, choosing pairing with `device` as its name, and returns the code and
 * approval page from the notification pika shows outside the TUI, with the command's promise.
 */
async function startPairing(machine: NewMachine, t: AuthTargets): Promise<{ code: string; link: string; command: Promise<void> }> {
	const { ui, pi } = machine;
	const notes = ui.notes.length;
	ui.choices = [PAIR];
	ui.inputs = [t.device];
	const command = pi.session.prompt(`/pika login ${t.url}`);
	// A failure before the code shows would otherwise only surface as a timeout.
	command.catch(() => {});
	const pattern = new RegExp(`^To pair this machine with pika as ${escapeRegExp(t.device)}, open (\\S+) and approve the code (\\S+)\\. The code expires in 10 minutes; waiting for approval…$`);
	const match = await waitFor(() => ui.notes.slice(notes).map((note) => pattern.exec(note.message)).find(Boolean) ?? false, 10_000, "pika to show the pairing code");
	const [link, code] = [match[1]!, match[2]!];
	checkEqual(link, `${t.url}/devices?pair=${encodeURIComponent(code)}`, "the approval page pika shows");
	check(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code), `the pairing code ${code} is not XXXX-XXXX from the code alphabet`);
	checkEqual(ui.selects.at(-1), { title: METHOD_TITLE, options: [PAIR, PASTE] }, "the login method prompt");
	check(ui.prompts.at(-1)?.title.startsWith("Device name for this machine"), `pika asked ${JSON.stringify(ui.prompts.at(-1))} instead of the device name`);
	return { code, link, command };
}

/** Opens the approval page the way the user would, and checks the request is highlighted with nothing edited. */
async function openRequest(browser: Ui, t: AuthTargets, code: string, link: string): Promise<string> {
	await browser.page.goto(link, { waitUntil: "networkidle0" });
	const card = `[data-pairing="${code}"]`;
	await browser.visible(`${card}[data-highlighted]`);
	checkEqual(await browser.count("[data-pairing][data-highlighted]"), 1, "highlighted pairing requests");
	const name = await browser.page.$eval(`${card} input`, (input) => (input as HTMLInputElement).value);
	checkEqual(name, t.device, "the device name the approval page proposes");
	const text = await browser.textOf(card);
	check(text.includes(code) && /Expires in \d+:\d\d/.test(text), `the pairing request shows ${JSON.stringify(text)}`);
	check(!(await browser.count(`${card} [data-device-exists]`)), "the approval page reports that the new device already exists");
	await browser.shot("16-devices-pairing");
	return card;
}

/** The browser denies the first request: pi reports it and nothing changes on the machine or the server. */
export async function checkDeniedPairing(browser: Ui, machine: NewMachine, t: AuthTargets): Promise<void> {
	const { code, link, command } = await startPairing(machine, t);
	const card = await openRequest(browser, t, code, link);
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

interface Device { name: string; createdAt: string; createdVia: string; lastSeenAt?: string; lastHost?: string }
const devices = async (api: ReadApi) => (await api.get<{ items: Device[] }>("devices"))?.items ?? [];

/**
 * The browser approves the second request unchanged: pi saves the token like a pasted one, owner-only, and the
 * session uploads at once, attributed to the paired device. Returns the token.
 */
export async function checkApprovedPairing(browser: Ui, machine: NewMachine, t: AuthTargets): Promise<string> {
	const { code, link, command } = await startPairing(machine, t);
	const card = await openRequest(browser, t, code, link);
	await browser.click(`${card} button[aria-label="Approve ${code}"]`);
	await browser.visible("[data-notice=green]");
	checkEqual(await browser.textOf("[data-notice=green]"), `Approved ${t.device}. pi on that machine finishes logging in by itself.`, "the notice after approving");
	await withTimeout(command, DECIDED_MS, "/pika login to finish after the approval");
	const file = configFile(machine);
	const last = machine.ui.last;
	check(last?.type === "info" && last.message.startsWith(`Logged in to ${t.url} as ${t.device}; saved to ${file}.`) && last.message.includes(`This session now uploads to ${t.url}.`),
		`pika's message after the approval: ${JSON.stringify(last)}`);

	checkEqual(statSync(file).mode & 0o777, 0o600, "the mode of pika.json after pairing");
	const saved = JSON.parse(readFileSync(file, "utf8")) as { url?: string; token?: string };
	check(typeof saved.token === "string" && /^pika_[0-9a-f]{64}$/.test(saved.token), "pika.json holds no device token after pairing");
	checkEqual(saved.url, t.url, "the server URL in pika.json");
	const token = saved.token;
	check(!machine.secrets.includes(token), "pairing handed out the token of another device");
	machine.secrets.push(token);
	checkEqual((await t.api.get<{ items: unknown[] }>("pairings"))?.items, [], "pending pairings after the approval");

	// The session that ran /pika login joined at once; its next prompt uploads with the new token.
	await machine.pi.prompt(PROMPTS.paired);
	const sessionId = machine.pi.session.sessionId;
	const lines = () => readFileSync(machine.pi.session.sessionFile!, "utf8").split("\n").filter(Boolean).length;
	await waitFor(async () => ((await allEntries(t.api, sessionId))?.length ?? 0) === lines() || undefined, 10_000, "the paired machine's session to upload");
	const summary = await t.api.get<SessionSummary>(`sessions/${sessionId}`);
	checkEqual(summary?.device, t.device, "the device the paired machine's session is attributed to");
	const device = (await devices(t.api)).find((item) => item.name === t.device);
	checkEqual({ createdVia: device?.createdVia, seen: typeof device?.lastSeenAt === "string" }, { createdVia: "pairing", seen: true }, `the paired device ${t.device}`);
	noSecrets(machine);
	browser.noProblems("while approving a pairing request");
	log(`pairing: approved ${code}; pika.json is 0600 and session ${sessionId} uploads as ${t.device}`);
	return token;
}

/**
 * The Devices page lists the paired device with its last-seen time, in both themes; revoking it there makes the
 * server refuse its token at once, and the machine's uploader stops with a 401.
 */
export async function checkDevices(browser: Ui, machine: NewMachine, t: AuthTargets, token: string): Promise<void> {
	await browser.go("/devices");
	const row = `[data-device="${t.device}"]`;
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

	await browser.click(`button[aria-label="Revoke ${t.device}"]`);
	await browser.click("[role=dialog] button::-p-text(Revoke)");
	await browser.visible("[data-notice=green]");
	checkEqual(await browser.textOf("[data-notice=green]"), `Revoked ${t.device}.`, "the notice after revoking");
	await waitFor(async () => (await browser.count(row)) === 0, 5_000, "the revoked device to leave the list");
	check(!(await devices(t.api)).some((item) => item.name === t.device), "the revoked device is still listed by the API");

	const ingest = await fetch(`${t.url}/api/ingest/v1/batch`, {
		method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ client: { host: "e2e" } }),
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
	log(`devices: ${t.device} last seen ${cells[2]}; after revoking it, ingest answers 401 and /pika reports the uploader stopped`);
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
