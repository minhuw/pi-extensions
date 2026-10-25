// Step identity (§6).
import { createHash } from "node:crypto";
import { STEP_KEY_VERSION } from "../config.ts";

/** JSON with sorted object keys; undefined members are dropped, arrays keep their order. */
export function stableJson(value: unknown): string {
	return stable(value) ?? "null";
}

function stable(value: unknown): string | undefined {
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	const json = (value as { toJSON?: () => unknown }).toJSON;
	if (typeof json === "function") return stable(json.call(value));
	if (Array.isArray(value)) return `[${value.map((item) => stable(item) ?? "null").join(",")}]`;
	const members: string[] = [];
	for (const key of Object.keys(value).sort()) {
		const item = stable((value as Record<string, unknown>)[key]);
		if (item !== undefined) members.push(`${JSON.stringify(key)}:${item}`);
	}
	return `{${members.join(",")}}`;
}

export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Unambiguous hash of several strings (no separator collisions). */
export function hashParts(...parts: string[]): string {
	return sha256Hex(JSON.stringify(parts));
}

export function stepId(kind: string, role: string, prompt: string): string {
	return hashParts(kind, role, prompt).slice(0, 12);
}

export interface FingerprintInput {
	kind: string; role: string; roleSha: string; prompt: string; schema?: object; write: boolean; base: string;
	gates: ReadonlyArray<{ id: string; command: string }>;
}

export function stepFingerprint(input: FingerprintInput): string {
	const { kind, role, roleSha, prompt, schema, write, base } = input;
	const gates = input.gates.map(({ id, command }) => ({ id, command }));
	return sha256Hex(stableJson({ keyVersion: STEP_KEY_VERSION, kind, role, roleSha, prompt, schema, write, base, gates }));
}

const MAX_KEY_ID = 64;

/**
 * `<id>-<occurrence>`, safe as a file name and a ref component. Ids that need sanitizing, are too long, or contain
 * upper case (case-insensitive file systems) get a hash of the original appended so distinct ids stay distinct.
 */
export function stepKey(id: string, occurrence: number): string {
	if (!Number.isSafeInteger(occurrence) || occurrence < 0) throw new Error(`invalid step occurrence: ${occurrence}`);
	let safe = id.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/\.{2,}/g, (dots) => "_".repeat(dots.length)).replace(/^[.-]/, "_");
	if (safe !== id || !safe || safe.length > MAX_KEY_ID || /[A-Z]/.test(safe)) safe = `${safe.slice(0, MAX_KEY_ID - 9)}_${sha256Hex(id).slice(0, 8)}`;
	return `${safe}-${occurrence}`;
}

/** Matches keys `stepKey` can produce; used to reject unsafe keys in paths and refs. */
export function isStepKey(key: string): boolean {
	return key.length <= MAX_KEY_ID + 21 && /^[A-Za-z0-9_][A-Za-z0-9_.-]*-\d+$/.test(key) && !key.includes("..");
}

export function integrationKey(from: string, source: string, message: string): string {
	return hashParts(from, source, message);
}

/** Counts earlier calls with the same id and fingerprint within one launch. */
export class Occurrences {
	readonly #seen = new Map<string, number>();
	next(id: string, fingerprint: string): number {
		const key = JSON.stringify([id, fingerprint]);
		const count = this.#seen.get(key) ?? 0;
		this.#seen.set(key, count + 1);
		return count;
	}
}
