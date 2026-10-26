import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { acquireUploader, currentUploader, releaseUploader, type Uploader } from "../uploader.ts";
import { MockIngest, TOKEN } from "./support/ingest-server.ts";
import { readText, waitFor, Workspace } from "./support/runtime.ts";

// The process-wide uploader is replaced when the login changes; the replacement takes over its open streams.
let workspace: Workspace;
let ingest: MockIngest;
const replaced: Uploader[] = [];
beforeEach(async () => { workspace = await Workspace.create(); ingest = await new MockIngest().start(); });
afterEach(async () => {
	for (const uploader of replaced.splice(0)) await uploader.stop();
	const current = currentUploader();
	if (current) await releaseUploader(current);
	await ingest.stop();
	await workspace.cleanup();
});

const key = "session:replaced";
const line = (n: number) => `${JSON.stringify({ type: "message", n })}\n`;

async function openSession(): Promise<{ file: string; options: { url: string; token: string; dir: string }; first: Uploader }> {
	const file = join(workspace.root, "session.jsonl");
	await writeFile(file, line(1));
	const options = { url: ingest.url, token: TOKEN, dir: workspace.pikaDir };
	const first = acquireUploader(options);
	replaced.push(first);
	await first.openStream({ key, kind: "session", path: file });
	await waitFor(async () => ingest.data(key) === await readText(file), 5_000, "first upload");
	return { file, options, first };
}

it("keeps a session stream open through two replacements in a row", async () => {
	const { file, options, first } = await openSession();
	// Two logins in one tick: the second replaces an uploader that is still taking over from the first.
	const second = acquireUploader({ ...options, token: "another-token" });
	const third = acquireUploader(options);
	replaced.push(second);
	expect(new Set([first, second, third]).size).toBe(3);
	await third.ready;
	// Caught up, the stream would be archived here if no one had it open.
	await third.flush();
	await appendFile(file, line(2));
	await waitFor(async () => ingest.data(key) === await readText(file), 5_000, "lines after the replacements");
	expect(third.status().lastError).toBeUndefined();
}, 20_000);

it("replaces an uploader a 401 stopped, even for the same login", async () => {
	const { file, options, first } = await openSession();
	ingest.mode = "unauthorized";
	await appendFile(file, line(2));
	await waitFor(() => first.isHalted, 5_000, "a 401");
	expect(first.status().halted).toMatch(/^the server rejected the token \(401\)/);

	ingest.mode = "ok";
	const second = acquireUploader(options);
	expect(second).not.toBe(first);
	expect(acquireUploader(options)).toBe(second);
	await waitFor(async () => ingest.data(key) === await readText(file), 5_000, "upload after the replacement");
	expect(second.status().halted).toBeUndefined();
}, 20_000);
