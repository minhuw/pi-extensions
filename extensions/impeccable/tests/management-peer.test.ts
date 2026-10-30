import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runOperation } from "../src/operations.ts";
import { readConfigs } from "../src/project.ts";
import { detectorFixture } from "./support/detector-fixture.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
	withFileMutationQueue: undefined,
}));
isolateEngineEnvironment();

it("retains read-only controls and safely refuses management writes when a peer lacks the public native queue", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ product: { keep: 1 } });
		const before = (await readConfigs(h.directory)).map((config) => config.text);
		expect((await runOperation({ argv: ["hooks", "status"], cwd: h.directory }, h.api)).ok).toBe(true);
		for (const argv of [["hooks", "on"], ["hooks", "reset"], ["ignores", "add-file", "page.html"], ["pin", "layout"]]) {
			const result = await runOperation({ argv, cwd: h.directory }, h.api);
			expect(result).toMatchObject({ ok: false, status: "error", integration: { committed: [], partial: false } });
			expect(result.stderr).toContain("management writes are unavailable");
		}
		expect((await readConfigs(h.directory)).map((config) => config.text)).toEqual(before);
		await expect(readFile(path.join(h.directory, ".pi/prompts/layout.md"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(JSON.parse((await runOperation({ argv: ["doctor", "--json"], cwd: h.directory }, h.api)).stdout).findings).toHaveLength(1);
	} finally { await h.close(); }
});
