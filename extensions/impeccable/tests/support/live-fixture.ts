import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { LiveOwner } from "../../src/live.ts";

export const generateEvent = { type: "generate", id: "ab12cd34", action: "bolder", count: 1, pageUrl: "/", element: { tagName: "h1", id: "hero", outerHTML: '<h1 id="hero">Original</h1>' } };
export async function liveFixture() {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-impeccable-live-test-")));
	const directory = path.join(root, ".impeccable/live");
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, "config.json"), JSON.stringify({ files: ["index.html"], insertBefore: "</body>", commentSyntax: "html", cspChecked: true }));
	await writeFile(path.join(root, "index.html"), '<h1 id="hero">Original</h1>');
	const binary = fileURLToPath(new URL("./live-engine.mjs", import.meta.url));
	await chmod(binary, 0o755);
	const env = { IMPECCABLE_LIVE_FIXTURE: root };
	const owners: LiveOwner[] = [];
	const owner = (session = "session-one", changed: (owner: LiveOwner) => void = () => {}) => {
		const live = new LiveOwner(session, changed, { binary, env }); owners.push(live); return live;
	};
	return {
		root, directory, binary, env, owner,
		write: (name: string, value: unknown) => writeFile(path.join(directory, name), JSON.stringify(value)),
		async calls() { return (await readFile(path.join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; pid: number }); },
		async cleanup() { await Promise.all(owners.map((live) => live.pause("test cleanup", true))); await rm(root, { recursive: true, force: true }); },
	};
}
export async function phase(live: LiveOwner, expected: string) {
	try { await expect.poll(() => live.phase, { timeout: 12_000 }).toBe(expected); }
	catch (error) { throw new Error(`Expected live phase ${expected}: ${JSON.stringify(live.view())}`, { cause: error }); }
}
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
