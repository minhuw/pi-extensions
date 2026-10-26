import { isDeepStrictEqual } from "node:util";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function log(message: string): void {
	process.stdout.write(`e2e: ${message}\n`);
}

export class CheckFailed extends Error {}

export function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new CheckFailed(message);
}

export function checkEqual(actual: unknown, expected: unknown, message: string): void {
	if (!isDeepStrictEqual(actual, expected)) {
		const show = (value: unknown) => {
			const text = JSON.stringify(value);
			return text && text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
		};
		throw new CheckFailed(`${message}\n  expected: ${show(expected)}\n  actual:   ${show(actual)}`);
	}
}

/** Polls `probe` until it returns a value other than undefined or false; returns that value. */
export async function waitFor<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs: number, label: string, intervalMs = 100): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	for (;;) {
		try {
			const value = await probe();
			if (value !== undefined && value !== false) return value;
		} catch (error) {
			lastError = error;
		}
		if (Date.now() > deadline) {
			throw new CheckFailed(`timed out after ${timeoutMs} ms waiting for ${label}${lastError ? ` (last error: ${(lastError as Error).message})` : ""}`);
		}
		await sleep(intervalMs);
	}
}

export function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set; run services/pika/scripts/e2e.sh`);
	return value;
}
