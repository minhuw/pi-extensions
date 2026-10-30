import * as fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runOperation } from "../src/operations.ts";
import { serialized } from "../src/project.ts";
import { detectorFixture } from "./support/detector-fixture.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

isolateEngineEnvironment();

const cases = ["--project", "--user"].flatMap((scope) =>
	["create", "replace", "remove"].flatMap((action) =>
		["already-aborted", "management-queue", "file-queue"].map((wait) => ({ scope, action, wait }))));

it.each(cases)("cancels $scope prompt $action after $wait without changing the shortcut", async ({ scope, action, wait }) => {
	const h = await detectorFixture();
	const previous = process.env.PI_CODING_AGENT_DIR;
	const controller = new AbortController();
	let release = () => {};
	let blocker: Promise<void> | undefined;
	try {
		process.env.PI_CODING_AGENT_DIR = path.join(h.directory, "private agent");
		const file = path.join(scope === "--user" ? process.env.PI_CODING_AGENT_DIR : path.join(h.directory, ".pi"), "prompts/layout.md");
		if (action !== "create") {
			expect((await runOperation({ argv: ["pin", "pin", "layout", scope], cwd: h.directory }, h.api)).ok).toBe(true);
			await fs.appendFile(file, "\nExisting owned shortcut customization\n");
		}
		const before = action === "create" ? undefined : await fs.readFile(file, "utf8");
		let metadataRead = Promise.resolve();
		if (wait !== "already-aborted") {
			const gate = new Promise<void>((resolve) => { release = resolve; });
			blocker = serialized(wait === "management-queue" ? "pi-impeccable-management" : file, () => gate);
			if (wait === "file-queue") {
				let observed!: () => void;
				metadataRead = new Promise<void>((resolve) => { observed = resolve; });
				const readFile = fs.readFile;
				vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
					const result = await readFile(...args);
					if (String(args[0]).endsWith("/scripts/command-metadata.json")) observed();
					return result;
				});
			}
		} else controller.abort();
		const operation = runOperation({ argv: ["pin", action === "remove" ? "unpin" : "pin", "layout", scope], cwd: h.directory, signal: controller.signal }, h.api);
		if (wait === "file-queue") {
			await metadataRead;
			// Let metadata parsing enqueue the operation on the held prompt queue.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		controller.abort();
		release();
		const result = await operation;
		expect(result).toMatchObject({ ok: false, status: "cancelled", integration: { engineRun: false } });
		expect(result.stderr).toContain("cancelled");
		if (before === undefined) await expect(fs.readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		else expect(await fs.readFile(file, "utf8")).toBe(before);
		expect(await fs.readdir(path.dirname(file)).catch(() => [])).toEqual(before === undefined ? [] : ["layout.md"]);
	} finally {
		release(); await blocker;
		vi.restoreAllMocks();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		await h.close();
	}
});

it.each(["pin", "unpin"])("cancels %s after prompt IO and before replacement/removal, cleaning temporary files", async (action) => {
	const h = await detectorFixture();
	try {
		const file = path.join(h.directory, ".pi/prompts/layout.md");
		expect((await runOperation({ argv: ["pin", "pin", "layout"], cwd: h.directory }, h.api)).ok).toBe(true);
		await fs.appendFile(file, "\nKeep this existing owned prompt\n");
		const before = await fs.readFile(file, "utf8");
		const controller = new AbortController();
		if (action === "unpin") {
			const readFile = fs.readFile;
			vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
				const result = await readFile(...args);
				if (args[0] === file) controller.abort();
				return result;
			});
		} else {
			const open = fs.open;
			vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await open(...args);
				if (String(args[0]).startsWith(`${file}.`)) {
					const write = handle.writeFile.bind(handle);
					vi.spyOn(handle, "writeFile").mockImplementation(async (...values) => { await write(...values); controller.abort(); });
				}
				return handle;
			});
		}
		const result = await runOperation({ argv: ["pin", action, "layout"], cwd: h.directory, signal: controller.signal }, h.api);
		expect(controller.signal.aborted).toBe(true);
		expect(result).toMatchObject({ ok: false, status: "cancelled", integration: { engineRun: false } });
		expect(await fs.readFile(file, "utf8")).toBe(before);
		expect(await fs.readdir(path.dirname(file))).toEqual(["layout.md"]);
	} finally { vi.restoreAllMocks(); await h.close(); }
});
