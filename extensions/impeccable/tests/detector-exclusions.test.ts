import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { detectorFixture } from "./support/detector-fixture.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";

isolateEngineEnvironment();
const exec = promisify(execFile);
async function waitFor(file: string) {
	const deadline = performance.now() + 5000;
	while (!await fs.stat(file).catch(() => undefined)) {
		if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

it("protects hook child exclusion maintenance against sibling-workspace scans and an actual SDK native exclusion edit", async () => {
	const first = await detectorFixture(undefined, [], { cwd: "apps/web" });
	const sibling = path.join(first.directory, "apps/admin");
	const second = await detectorFixture(undefined, [], { cwd: sibling });
	const gate = path.join(first.directory, "release-exclusion");
	const running: Promise<unknown>[] = [];
	try {
		process.env.IMPECCABLE_BIN = first.binary;
		await exec("git", ["init"], { cwd: first.directory });
		await fs.writeFile(path.join(first.directory, "package.json"), '{"workspaces":["apps/*"]}');
		const file = path.join(first.directory, ".git/info/exclude");
		await fs.writeFile(file, "# User excludes\nprivate-file\n");
		for (const [root, entry, gated] of [[path.join(first.directory, "apps/web"), "/apps/web/.impeccable/config.local.json", true], [sibling, "/apps/admin/.impeccable/config.local.json", false]] as const) {
			await fs.mkdir(path.join(root, ".impeccable"), { recursive: true });
			await fs.writeFile(path.join(root, "package.json"), '{}');
			await fs.writeFile(path.join(root, ".impeccable/config.json"), JSON.stringify({ hook: { enabled: true }, fixtureExclude: { file, entry, ...(gated ? { gate } : {}) } }));
		}
		for (const h of [first, second]) h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "changed" })]), fauxAssistantMessage("Done"), fauxAssistantMessage("Assessed")]);
		const one = first.session.prompt("Edit web"); running.push(one);
		await waitFor(path.join(first.directory, "apps/web/exclude-read"));
		let nativeFinished = false;
		const native = createEditToolDefinition(first.directory).execute("native-exclude", { path: file, edits: [{ oldText: "private-file", newText: "private-file\nnative-user-entry" }] }, undefined, undefined, undefined!).then(() => { nativeFinished = true; });
		running.push(native);
		const two = second.session.prompt("Edit admin"); running.push(two);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(nativeFinished).toBe(false);
		expect(await fs.stat(path.join(sibling, "exclude-read")).catch(() => undefined)).toBeUndefined();
		await fs.writeFile(gate, "release"); await Promise.all(running);
		const text = await fs.readFile(file, "utf8");
		expect(text).toContain("# User excludes\nprivate-file\nnative-user-entry\n");
		expect(text).toContain("/apps/web/.impeccable/config.local.json\n");
		expect(text).toContain("/apps/admin/.impeccable/config.local.json\n");
		expect(first.feedback().length).toBeGreaterThan(0);
		expect(second.feedback().length).toBeGreaterThan(0);
		expect(first.errors).toEqual([]); expect(second.errors).toEqual([]);
	} finally {
		await fs.writeFile(gate, "release"); await Promise.allSettled(running);
		await second.close(); await first.close();
	}
});
