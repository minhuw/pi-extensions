import { hostname } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { PIKA_VERSION } from "./uploader.ts";

export const PAIR_REQUEST_TIMEOUT_MS = 5_000;
/** How long `/pika login` waits for an approval, and the shortest poll interval it accepts; tests lower both. */
export const pairingLimits = { timeoutMs: 10 * 60_000, minIntervalMs: 1_000 };
const MAX_INTERVAL_MS = 30_000;
/** Polls in a row that fail before pairing gives up; a single lost answer does not end it. */
const MAX_POLL_FAILURES = 3;
/** Every device id the server makes matches this; names are free text (`validDeviceName`). */
export const DEVICE_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** The only device names pika servers older than 0.4 accept. */
export const LEGACY_DEVICE_NAME = DEVICE_ID;
const CODE = /^[A-Za-z0-9-]{1,32}$/;
const NOT_IN_NAMES = /[\p{Cc}\u2028\u2029]/u;

/** Whether `name`, trimmed, is a device name: 1 to 64 characters without control characters or line and paragraph separators. */
export function validDeviceName(name: string): boolean {
	const trimmed = name.trim();
	const length = [...trimmed].length;
	return length >= 1 && length <= 64 && !NOT_IN_NAMES.test(trimmed);
}

/** The hostname without a trailing `.local`, at most 64 characters; `pi` when that is not a valid name. */
export function defaultDeviceName(host = hostname()): string {
	const name = [...host.trim().replace(/\.local$/i, "")].slice(0, 64).join("").trim();
	return validDeviceName(name) ? name : "pi";
}

/** `name` with every run of characters servers older than 0.4 refuse replaced by `-`, at most 64 characters; `pi` when nothing is left. */
export function legacyDeviceName(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64).replace(/^-+|-+$/g, "") || "pi";
}

/** A device the server approved this pairing as: its id, its name, and whether it continues an existing device. */
export interface PairedDevice { id: string; name: string; continued: boolean }

export interface Pairing {
	/** The device's secret for polling; never shown. */
	pairingId: string;
	code: string;
	expiresIn: number;
	interval: number;
}

/** `approved`: the server approved the pairing, and so created or continued the device, but its answer was unusable. */
export type Failure = { kind: "failed"; problem: string; approved?: { device?: PairedDevice } } | { kind: "cancelled" };
export type Started = { kind: "started"; pairing: Pairing } | { kind: "unsupported" } | Failure;
export type Approval = { kind: "approved"; device?: PairedDevice; token: string } | Failure;

const failed = (problem: string): Failure => ({ kind: "failed", problem });
const CANCELLED: Failure = { kind: "cancelled" };

/** POSTs JSON under `{url}/api/pair/v1/`; undefined when the server cannot be reached. Bodies are never echoed. */
async function post(url: string, path: string, body: unknown, signal: AbortSignal | undefined, token?: string): Promise<{ status: number; json: Record<string, unknown> } | undefined> {
	const timeout = AbortSignal.timeout(PAIR_REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(`${url}/api/pair/v1/${path}`, {
			method: "POST",
			redirect: "error",
			signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
			headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify(body),
		});
		let json: Record<string, unknown> = {};
		try {
			const value: unknown = await response.json();
			if (value && typeof value === "object" && !Array.isArray(value)) json = value as Record<string, unknown>;
		} catch { /* not JSON */ }
		return { status: response.status, json };
	} catch {
		return undefined;
	}
}

const positive = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * Asks the server for a pairing code for a device named `device`; `unsupported` when the server
 * predates pairing (404). `key` (this install's device key) and `token` (this machine's current
 * token for this same server) let the server recognize the device a re-pairing continues.
 */
export async function startPairing(url: string, device: string, signal?: AbortSignal, recognize: { key?: string; token?: string } = {}): Promise<Started> {
	const body = { device, host: hostname().slice(0, 255), pikaVersion: PIKA_VERSION, ...(recognize.key ? { key: recognize.key } : {}) };
	const response = await post(url, "start", body, signal, recognize.token);
	if (signal?.aborted) return CANCELLED;
	if (!response) return failed(`could not reach ${url}`);
	const { status, json } = response;
	if (status === 404) return { kind: "unsupported" };
	if (status === 400) {
		if (json.error === "invalid_key") return failed("the server refused this machine's device key");
		// A 0.4 server refuses only names this rule refuses too; one that refuses a name the rule allows is older.
		if (json.error === "invalid_device" && validDeviceName(device)) return failed("the server refused the device name; pika servers older than 0.4 accept only letters, digits, '.', '_', and '-'");
		if (json.error === "invalid_device") return failed("the server refused the device name");
		return failed(`the server refused the pairing request${typeof json.error === "string" && /^[a-z_]{1,64}$/.test(json.error) ? ` (${json.error})` : ""}`);
	}
	if (status === 429) {
		if (json.error === "too_many_pairings") return failed("the server has too many pending pairings; approve or deny them in the web UI, or wait until they expire");
		const after = positive(json.retryAfter, 0);
		return failed(`too many pairing attempts${after ? `; try again in ${Math.ceil(after)} s` : ""}`);
	}
	if (status !== 200) return failed(`unexpected HTTP ${status} from ${url}`);
	if (typeof json.pairingId !== "string" || !json.pairingId || typeof json.code !== "string" || !CODE.test(json.code)) return failed(`unexpected answer from ${url}`);
	return { kind: "started", pairing: { pairingId: json.pairingId, code: json.code, expiresIn: positive(json.expiresIn, 600), interval: positive(json.interval, 2) } };
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(true); }, ms);
		const abort = () => { clearTimeout(timer); resolve(false); };
		signal.addEventListener("abort", abort, { once: true });
	});
}

/**
 * Polls every `interval` seconds until the pairing is decided, ends, `signal` aborts, or
 * `pairingLimits.timeoutMs` passes. A poll already sent is not aborted, since the server creates
 * the device as it answers: an approval that arrives as `signal` aborts is still returned, and the
 * caller decides whether its login still wants it.
 */
export async function waitForApproval(url: string, pairing: Pairing, signal: AbortSignal): Promise<Approval> {
	const interval = Math.min(MAX_INTERVAL_MS, Math.max(pairingLimits.minIntervalMs, pairing.interval * 1000));
	const deadline = Date.now() + pairingLimits.timeoutMs;
	let failures = 0;
	for (;;) {
		const left = deadline - Date.now();
		if (left <= 0) return failed("the code was not approved in time");
		if (!(await sleep(Math.min(interval, left), signal))) return CANCELLED;
		if (Date.now() >= deadline) return failed("the code was not approved in time");
		const response = await post(url, "poll", { pairingId: pairing.pairingId }, undefined);
		const status = response?.status === 200 ? response.json.status : undefined;
		if (status === "approved") {
			const { token, device, name, continued } = response!.json;
			// Servers older than 0.4 send no name, and no `continued`: their device id is its name.
			const named = typeof device === "string" && DEVICE_ID.test(device)
				? { device: { id: device, name: typeof name === "string" && validDeviceName(name) ? name.trim() : device, continued: continued === true } }
				: {};
			if (typeof token !== "string" || !token.trim()) return { kind: "failed", problem: "the server approved the pairing but sent no token", approved: named };
			return { kind: "approved", token: token.trim(), ...named };
		}
		if (signal.aborted) return CANCELLED;
		if (response?.status === 404) return failed("the server no longer knows this pairing; run /pika login again");
		if (status === "pending") { failures = 0; continue; }
		if (status === "denied") return failed("the pairing was denied in the pika web UI");
		if (status === "expired") return failed("the code expired before it was approved; run /pika login again");
		if (++failures < MAX_POLL_FAILURES) continue;
		return failed(!response ? `could not reach ${url}` : response.status !== 200 ? `unexpected HTTP ${response.status} from ${url}` : `unexpected answer from ${url}`);
	}
}

const clock = (ms: number) => {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Shows the pairing code, the approval page, and the time left; re-renders every second until disposed. */
export class PairingView implements Component {
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly info: { code: string; link: string; deadline: number },
		tui: { requestRender(): void },
		private readonly theme: Pick<Theme, "fg" | "bold">,
		private readonly onCancel: () => void,
	) {
		this.timer = setInterval(() => tui.requestRender(), 1_000);
		this.timer.unref?.();
	}

	handleInput(data: string): void {
		if (getKeybindings().matches(data, "tui.select.cancel")) this.onCancel();
	}

	invalidate(): void {}

	dispose(): void { clearInterval(this.timer); }

	render(width: number): string[] {
		const w = Math.max(1, width);
		const { theme, info } = this;
		// The link is split rather than truncated, so all of it stays visible.
		const link: string[] = [];
		for (let at = 0; at < info.link.length; at += Math.max(1, w - 2)) link.push(`  ${info.link.slice(at, at + Math.max(1, w - 2))}`);
		return [
			theme.fg("accent", theme.bold("Pair this machine with pika")),
			"Open this page and approve the code:",
			...link,
			`Code: ${theme.bold(info.code)}`,
			theme.fg("dim", `Waiting for approval · expires in ${clock(info.deadline - Date.now())} · Esc cancels`),
		].map((line) => truncateToWidth(line, w));
	}
}
