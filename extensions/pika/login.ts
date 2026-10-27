import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readlink, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, truncateToWidth } from "@earendil-works/pi-tui";
import { normalizeUrl } from "./config.ts";
import { bindDeviceKey, deviceKey } from "./device-key.ts";
import { defaultDeviceName, LEGACY_DEVICE_NAME, legacyDeviceName, type PairedDevice, PairingView, pairingLimits, startPairing, validDeviceName, waitForApproval } from "./pairing.ts";
import { clientInfo } from "./uploader.ts";

export const VALIDATE_TIMEOUT_MS = 5_000;
export const METHOD_TITLE = "How should this machine log in?";
export const PAIR = "Pair with the pika web UI (recommended)";
export const PASTE = "Paste a token";
export const URL_TITLE = "pika server URL: the address you open the pika web UI at, e.g. https://pika.example.com or http://192.168.1.10:7171";
export const URL_PLACEHOLDER = "https://pika.example.com";
export const nameTitle = (suggested: string) => `Name for this machine in pika (any text up to 64 characters; blank uses ${suggested})`;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Whether a token sent to `url` travels unencrypted beyond this machine. */
export function isPlainRemote(url: string): boolean {
	const { protocol, hostname } = new URL(url);
	if (protocol !== "http:") return false;
	return !(hostname === "localhost" || hostname.endsWith(".localhost") || /^127(?:\.\d+){3}$/.test(hostname) || hostname === "[::1]");
}

/**
 * Sends an empty batch with `token`; undefined when the server accepts it, otherwise why not.
 * The answer names only the URL: never the token, the headers, or the response body.
 */
export async function validateToken(url: string, token: string, options: { piVersion?: string; signal?: AbortSignal } = {}): Promise<string | undefined> {
	const signal = options.signal ? AbortSignal.any([AbortSignal.timeout(VALIDATE_TIMEOUT_MS), options.signal]) : AbortSignal.timeout(VALIDATE_TIMEOUT_MS);
	let status: number;
	try {
		const response = await fetch(`${url}/api/ingest/v1/batch`, {
			method: "POST",
			redirect: "error",
			signal,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ client: clientInfo(options.piVersion) }),
		});
		status = response.status;
		await response.body?.cancel().catch(() => {});
	} catch {
		return options.signal?.aborted ? "login cancelled" : `could not reach ${url}`;
	}
	if (status === 200) return undefined;
	if (status === 401) return "the server rejected the token";
	if (status === 404) return `no pika ingest API at ${url}; check the base path`;
	return `unexpected HTTP ${status} from ${url}`;
}

/** Throws when `file` is a symbolic link to nothing, which pika neither replaces nor follows. */
async function refuseDangling(file: string): Promise<void> {
	const link = await readlink(file).catch(() => undefined);
	if (link !== undefined) throw new Error(`${file} is a symbolic link to ${link}, which does not exist; fix or remove the link`);
}

/** The fields of `pika.json`, or undefined when it does not exist; throws when it cannot be read or is not a JSON object. */
export async function readConfigFile(file: string): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read ${file}: ${errorText(error)}`);
		await refuseDangling(file);
		return undefined;
	}
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { /* reported below */ }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object; fix or remove it`);
	return parsed as Record<string, unknown>;
}

/**
 * Replaces `pika.json` atomically with a file only its owner can read. A symbolic link stays a
 * link: the file it points to is replaced instead.
 */
export async function writeConfigFile(file: string, fields: Record<string, unknown>): Promise<void> {
	let target = file;
	try {
		target = await realpath(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await refuseDangling(file);
	}
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(temp, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(fields, null, 2)}\n`);
		// The umask may have narrowed the mode further; the file is complete on disk before it replaces the old one.
		await handle.chmod(0o600);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temp, target);
	} catch (error) {
		await handle?.close().catch(() => {});
		await rm(temp, { force: true });
		throw error;
	}
}

/**
 * A single-line secret input: pi-tui's `Input` does the editing, including bracketed paste, but
 * only one `•` per character is ever rendered.
 */
export class MaskedInput implements Component {
	private readonly input = new Input();
	private finished = false;

	constructor(
		readonly title: string,
		private readonly tui: { requestRender(): void },
		private readonly theme: Pick<Theme, "fg" | "bold">,
		done: (token: string | undefined) => void,
	) {
		const finish = (token: string | undefined) => {
			if (this.finished) return;
			this.finished = true;
			done(token);
		};
		this.input.onSubmit = (value) => finish(value);
		this.input.onEscape = () => finish(undefined);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void { this.input.invalidate(); }

	render(width: number): string[] {
		const w = Math.max(1, width);
		const { theme } = this;
		const count = [...this.input.getValue()].length;
		return [
			theme.fg("accent", theme.bold(this.title)),
			count ? `•`.repeat(Math.min(count, w)) : theme.fg("dim", "(empty)"),
			theme.fg("dim", "enter confirm · esc cancel"),
		].map((line) => truncateToWidth(line, w));
	}
}

/** Where a successful login saved what; failures and cancels are reported and leave the file alone. */
export interface Login {
	url: string;
	file: string;
	/** `"enabled": false` was removed from the file. */
	reenabled: boolean;
	/** The device the server approved, after pairing. */
	device?: ApprovedDevice;
}

/** An approved device; `id` is unknown when the server's answer did not name it usably. */
export type ApprovedDevice = Omit<PairedDevice, "id"> & { id?: string };

/**
 * How a login learns that it no longer counts. `index.ts` keeps one login per process: a newer
 * `/pika login`, `/pika logout`, or the end of the session that started it aborts `signal` (with a
 * string reason) and makes `isCurrent()` false.
 */
export interface LoginControl {
	signal: AbortSignal;
	/** Whether this login may still save; checked just before the file is written. */
	isCurrent(): boolean;
	/** Whether the session that started it is open; once it is not, its ctx must not be used. */
	isOpen(): boolean;
	/** Set while the login waits for a pairing to be approved. */
	waiting?: boolean;
}

/** A control for a lone login: only the command's signal, when pi gives one, cancels it. */
const lone = (ctx: ExtensionCommandContext): LoginControl => ({ signal: ctx.signal ?? new AbortController().signal, isCurrent: () => true, isOpen: () => true });

async function promptToken(ctx: ExtensionCommandContext, url: string, signal: AbortSignal): Promise<string | undefined> {
	const title = `pika token for ${url}`;
	if (ctx.mode === "tui") return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => new MaskedInput(title, tui, theme, done));
	return ctx.ui.input(`${title} (pika cannot mask it in this client)`, undefined, { signal });
}

/** `device` of a failure names the device an unusable approval created or continued. */
type Paired = { kind: "approved"; device: ApprovedDevice; token: string } | { kind: "failed"; problem: string; device?: ApprovedDevice } | { kind: "cancelled" } | { kind: "unsupported" };

/** What lets the server recognize a re-pairing: this install's device key, and the configured token when it belongs to `url`. */
export interface Recognition { keyDir: string; configured: { url?: string; token?: string } }

/** Asks for this machine's device name until it is valid; blank takes the suggestion, and undefined means cancelled. */
async function promptName(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<string | undefined> {
	const suggested = defaultDeviceName();
	for (;;) {
		const answer = await ctx.ui.input(nameTitle(suggested), suggested, { signal });
		if (answer === undefined || signal.aborted) return undefined;
		const name = answer.trim() || suggested;
		if (validDeviceName(name)) return name;
		ctx.ui.notify("pika: that name does not work: use 1 to 64 characters, without control characters. Enter another, or press Esc to cancel.", "warning");
	}
}

/** The configured token, when the configured URL is `url`; never a token for another server. */
function tokenFor(url: string, configured: Recognition["configured"]): string | undefined {
	if (!configured.url || !configured.token) return undefined;
	try { return normalizeUrl(configured.url) === url ? configured.token : undefined; } catch { return undefined; }
}

/**
 * Pairs this machine through the web UI: asks for a device name, shows the code and the approval
 * page, and waits for the decision. `unsupported` means the server predates pairing; `device` of an
 * approval is what the server gave, else the name asked for.
 */
async function pair(ctx: ExtensionCommandContext, url: string, control: LoginControl, recognition: Recognition): Promise<Paired> {
	const { signal } = control;
	const device = await promptName(ctx, signal);
	if (device === undefined) return { kind: "cancelled" };
	const key = await deviceKey(recognition.keyDir);
	if (signal.aborted) return { kind: "cancelled" };
	const token = tokenFor(url, recognition.configured);
	const started = await startPairing(url, device, signal, { ...(key ? { key } : {}), ...(token ? { token } : {}) });
	if (started.kind === "unsupported") {
		if (signal.aborted) return { kind: "cancelled" };
		ctx.ui.notify(LEGACY_DEVICE_NAME.test(device)
			? `${url} cannot pair devices: it is a pika server older than 0.2. Paste a token from \`pika token create ${device}\` instead.`
			: `${url} cannot pair devices: it is a pika server older than 0.2, which accepts only letters, digits, '.', '_', and '-' in device names. Paste a token from \`pika token create ${legacyDeviceName(device)}\` instead.`, "warning");
		return started;
	}
	if (started.kind !== "started") return started;
	const { code, expiresIn } = started.pairing;
	const link = `${url}/devices?pair=${encodeURIComponent(code)}`;
	const lifetime = Math.min(expiresIn * 1000, pairingLimits.timeoutMs);
	const cancel = new AbortController();
	control.waiting = true;
	// The server's answer did not say which device it approved: only the name asked for is known.
	const asked: ApprovedDevice = { name: device, continued: false };
	const waiting = waitForApproval(url, started.pairing, AbortSignal.any([cancel.signal, signal]))
		.then((outcome): Paired => {
			if (outcome.kind === "approved") return { ...outcome, device: outcome.device ?? asked };
			if (outcome.kind === "failed" && outcome.approved) return { kind: "failed", problem: outcome.problem, device: outcome.approved.device ?? asked };
			return outcome;
		})
		.finally(() => { control.waiting = false; });
	if (ctx.mode === "tui") {
		const deadline = Date.now() + lifetime;
		const shown = ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			void waiting.then(() => done());
			return new PairingView({ code, link, deadline }, tui, theme, () => cancel.abort());
		}).catch(() => { cancel.abort(); });
		const outcome = await waiting;
		await shown;
		return outcome;
	}
	const minutes = Math.max(1, Math.round(lifetime / 60_000));
	ctx.ui.notify(`To pair this machine with pika as ${device}, open ${link} and approve the code ${code}. The code expires in ${minutes} minute${minutes === 1 ? "" : "s"}; waiting for approval…`, "info");
	return waiting;
}

/** Asks for the server URL until it is valid; blank keeps `current`, and undefined means cancelled. */
async function promptUrl(ctx: ExtensionCommandContext, current: string | undefined, signal: AbortSignal): Promise<string | undefined> {
	const title = current ? `${URL_TITLE} (blank keeps ${current})` : URL_TITLE;
	for (;;) {
		const answer = await ctx.ui.input(title, current ?? URL_PLACEHOLDER, { signal });
		if (answer === undefined || signal.aborted) return undefined;
		const entered = answer.trim() || current;
		let problem: string;
		if (!entered) problem = "no server URL entered, and none is saved to keep";
		else if (!/^https?:\/\//i.test(entered)) problem = "the server URL must start with http:// or https://";
		else {
			try { return normalizeUrl(entered); } catch (error) { problem = errorText(error); }
		}
		ctx.ui.notify(`pika: ${problem}. Enter the address you open the pika web UI at, e.g. ${URL_PLACEHOLDER}, or press Esc to cancel.`, "warning");
	}
}

/** How an approved device is named in messages: its name, and its id when it is known and differs. */
const deviceText = (device: ApprovedDevice) => device.id === undefined || device.name === device.id ? device.name : `${device.name} (${device.id})`;

/**
 * Asks for the server URL (`arg`, or blank keeps `current`), then pairs with the web UI or takes a
 * newly entered token, validates the token against the server, and saves both to `file`, keeping
 * its other fields; then binds this install's device key to the token's device, in the
 * background. Once `control` says the login was replaced or its session ended, it saves nothing;
 * after its session ended it does not show anything either.
 */
export async function login(ctx: ExtensionCommandContext, file: string, arg: string | undefined, current: string | undefined, piVersion?: string, control: LoginControl = lone(ctx)): Promise<Login | undefined> {
	const { signal } = control;
	// Pairing creates or continues the device on the server, so a login that ends without its token says which.
	let paired: { device: ApprovedDevice; url: string } | undefined;
	const orphan = () => {
		if (!paired) return " Nothing changed.";
		const { device, url } = paired;
		const what = deviceText(device);
		return device.continued
			? ` The pairing gave the existing device ${what} on ${url} a new token, which stopped its previous one, but this machine did not keep it; run /pika login again, or revoke ${what} on the Devices page (${url}/devices). ${file} is unchanged.`
			: ` The pairing created the device ${what} on ${url}, but this machine did not keep its token; revoke ${what} on the Devices page (${url}/devices). ${file} is unchanged.`;
	};
	const notify = (message: string, type: "info" | "error") => { if (control.isOpen()) ctx.ui.notify(message, type); return undefined; };
	const fail = (message: string) => notify(`pika login failed: ${message}.${orphan()}`, "error");
	const cancelled = () => notify(`pika login cancelled${typeof signal.reason === "string" ? `: ${signal.reason}` : ""}.${orphan()}`, paired ? "error" : "info");
	if (!ctx.hasUI) {
		ctx.ui.notify(`/pika login needs an interactive UI. Edit ${file} or set PIKA_URL and PIKA_TOKEN instead.`, "error");
		return undefined;
	}
	let before: Record<string, unknown> | undefined;
	try { before = await readConfigFile(file); } catch (error) { return fail(errorText(error)); }
	const stored = (name: "url" | "token") => typeof before?.[name] === "string" ? (before[name] as string).trim() : "";
	const recognition: Recognition = {
		keyDir: join(dirname(file), "pika"),
		configured: { url: process.env.PIKA_URL?.trim() || stored("url") || undefined, token: process.env.PIKA_TOKEN?.trim() || stored("token") || undefined },
	};

	let url: string;
	const entered = arg?.trim();
	if (entered) {
		try { url = normalizeUrl(entered); } catch (error) { return fail(errorText(error)); }
	} else {
		const answer = await promptUrl(ctx, current, signal);
		if (answer === undefined) return cancelled();
		url = answer;
	}

	const method = await ctx.ui.select(METHOD_TITLE, [PAIR, PASTE], { signal });
	if (method === undefined || signal.aborted) return cancelled();
	let token: string | undefined;
	let device: ApprovedDevice | undefined;
	if (method === PAIR) {
		const outcome = await pair(ctx, url, control, recognition);
		if (outcome.kind === "approved") {
			({ token, device } = outcome);
			paired = { device, url };
			// An approval that raced a cancel counts only while this is still the current login.
			if (!control.isCurrent()) return cancelled();
		} else if (outcome.kind === "cancelled") return cancelled();
		else if (outcome.kind === "failed") {
			if (outcome.device) paired = { device: outcome.device, url };
			return fail(outcome.problem);
		}
		// A server without pairing falls through to the token prompt.
	}
	if (token === undefined) {
		const answer = await promptToken(ctx, url, signal);
		if (answer === undefined || signal.aborted) return cancelled();
		token = answer.trim();
		if (!token) return fail("no token entered");
	}

	notify(`Checking the token with ${url}…`, "info");
	// An approval kept after the command's own signal aborted is still checked.
	const problem = await validateToken(url, token, { piVersion, signal: signal.aborted ? undefined : signal });
	if (!control.isCurrent()) return cancelled();
	if (problem) return problem === "login cancelled" ? cancelled() : fail(problem);

	try {
		const fields = await readConfigFile(file) ?? {};
		const reenabled = fields.enabled === false;
		if (reenabled) delete fields.enabled;
		if (!control.isCurrent()) return cancelled();
		await writeConfigFile(file, { ...fields, url, token });
		void bindDeviceKey(url, token, recognition.keyDir);
		return { url, file, reenabled, ...(device ? { device } : {}) };
	} catch (error) {
		return fail(errorText(error));
	}
}
