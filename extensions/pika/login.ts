import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readlink, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, truncateToWidth } from "@earendil-works/pi-tui";
import { clientInfo } from "./uploader.ts";

export const VALIDATE_TIMEOUT_MS = 5_000;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The server URL as pika stores it: http(s) only, without credentials, a query, or a fragment, and
 * with the server's base path kept but no trailing slash. Messages never repeat the input, which
 * may be a mistyped token.
 */
export function normalizeUrl(input: string): string {
	const text = input.trim();
	let url: URL;
	try { url = new URL(text); } catch { throw new Error("the server URL is not a valid URL"); }
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the server URL must start with http:// or https://");
	if (url.username || url.password) throw new Error("the server URL must not contain credentials");
	if (url.search || url.hash || /[?#]/.test(text)) throw new Error("the server URL must not have a query or fragment");
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

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
}

async function promptToken(ctx: ExtensionCommandContext, url: string): Promise<string | undefined> {
	const title = `pika token for ${url}`;
	if (ctx.mode === "tui") return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => new MaskedInput(title, tui, theme, done));
	return ctx.ui.input(`${title} (pika cannot mask it in this client)`);
}

/**
 * Asks for the server URL (`arg`, or blank keeps `current`) and a newly entered token, validates
 * them against the server, and saves them to `file`, keeping its other fields.
 */
export async function login(ctx: ExtensionCommandContext, file: string, arg: string | undefined, current: string | undefined, piVersion?: string): Promise<Login | undefined> {
	const fail = (message: string) => { ctx.ui.notify(`pika login failed: ${message}. Nothing changed.`, "error"); return undefined; };
	const cancelled = () => { ctx.ui.notify("pika login cancelled. Nothing changed.", "info"); return undefined; };
	if (!ctx.hasUI) {
		ctx.ui.notify(`/pika login needs an interactive UI. Edit ${file} or set PIKA_URL and PIKA_TOKEN instead.`, "error");
		return undefined;
	}
	try { await readConfigFile(file); } catch (error) { return fail(errorText(error)); }

	let entered = arg?.trim();
	if (!entered) {
		const answer = await ctx.ui.input(current ? `pika server URL (blank keeps ${current})` : "pika server URL", current);
		if (answer === undefined) return cancelled();
		entered = answer.trim() || current;
		if (!entered) return fail("no server URL entered");
	}
	let url: string;
	try { url = normalizeUrl(entered); } catch (error) { return fail(errorText(error)); }

	const answer = await promptToken(ctx, url);
	if (answer === undefined) return cancelled();
	const token = answer.trim();
	if (!token) return fail("no token entered");

	ctx.ui.notify(`Checking the token with ${url}…`, "info");
	const problem = await validateToken(url, token, { piVersion, signal: ctx.signal });
	if (problem) return fail(problem);

	try {
		const fields = await readConfigFile(file) ?? {};
		const reenabled = fields.enabled === false;
		if (reenabled) delete fields.enabled;
		await writeConfigFile(file, { ...fields, url, token });
		return { url, file, reenabled };
	} catch (error) {
		return fail(errorText(error));
	}
}
