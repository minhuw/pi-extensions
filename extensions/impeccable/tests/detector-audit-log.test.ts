import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { hookStatus, resolveAuditLogPath } from "../src/project.ts";
import { detectorFixture } from "./support/detector-fixture.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";

isolateEngineEnvironment();

const missing = async (file: string) => {
	await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
};

it("tracks hook.auditLog provenance across shared config, local config, and IMPECCABLE_HOOK_LOG", async () => {
	const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-impeccable-audit-prov-")));
	const previousLog = process.env.IMPECCABLE_HOOK_LOG;
	try {
		delete process.env.IMPECCABLE_HOOK_LOG;
		await mkdir(path.join(dir, ".impeccable"), { recursive: true });
		expect((await hookStatus(dir)).auditLog).toBeUndefined();

		await writeFile(path.join(dir, ".impeccable/config.json"), JSON.stringify({ hook: { enabled: true, auditLog: "../shared.ndjson" } }));
		expect((await hookStatus(dir)).auditLog).toEqual({ path: "../shared.ndjson", source: "shared" });

		await writeFile(path.join(dir, ".impeccable/config.local.json"), JSON.stringify({ hook: { consent: "accepted" } }));
		expect((await hookStatus(dir)).auditLog).toEqual({ path: "../shared.ndjson", source: "shared" });

		await writeFile(path.join(dir, ".impeccable/config.local.json"), JSON.stringify({ hook: { consent: "accepted", auditLog: "~/local.ndjson" } }));
		expect((await hookStatus(dir)).auditLog).toEqual({ path: "~/local.ndjson", source: "local" });

		await writeFile(path.join(dir, ".impeccable/config.local.json"), JSON.stringify({ hook: { consent: "accepted", auditLog: "" } }));
		expect((await hookStatus(dir)).auditLog).toBeUndefined();

		process.env.IMPECCABLE_HOOK_LOG = "~/env.ndjson";
		expect((await hookStatus(dir)).auditLog).toEqual({ path: "~/env.ndjson", source: "env" });
	} finally {
		if (previousLog === undefined) delete process.env.IMPECCABLE_HOOK_LOG;
		else process.env.IMPECCABLE_HOOK_LOG = previousLog;
		await rm(dir, { recursive: true, force: true });
	}
});

it("confines shared repo hook.auditLog paths while allowing trusted local and env paths", async () => {
	const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-impeccable-audit-resolve-")));
	const root = path.join(base, "project");
	const sibling = path.join(base, "project-evil");
	const outside = path.join(base, "outside");
	const fakeHome = path.join(base, "home");
	await mkdir(path.join(root, "nested"), { recursive: true });
	await mkdir(path.join(root, "logs"), { recursive: true });
	await mkdir(sibling, { recursive: true });
	await mkdir(outside, { recursive: true });
	await mkdir(fakeHome, { recursive: true });
	await writeFile(path.join(outside, "existing.ndjson"), "");
	await symlink(outside, path.join(root, "dir-link"));
	await symlink(path.join(outside, "missing-dir"), path.join(root, "dangling-dir-link"));
	await symlink(path.join(outside, "existing.ndjson"), path.join(root, "file-link.ndjson"));
	await symlink(path.join(outside, "new.ndjson"), path.join(root, "dangling-file-link.ndjson"));
	await symlink("../../outside/rel-new.ndjson", path.join(root, "nested/rel-link.ndjson"));
	await symlink("hop2", path.join(root, "hop1"));
	await symlink(path.join(outside, "multi-hop.ndjson"), path.join(root, "hop2"));
	await symlink("loop-b", path.join(root, "loop-a"));
	await symlink("loop-a", path.join(root, "loop-b"));
	await symlink(path.join(root, "logs/real.ndjson"), path.join(root, "internal-link.ndjson"));

	vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
	try {
		for (const bad of [
			"~",
			"~/escape.ndjson",
			"~other/escape.ndjson",
			".",
			"../outside.ndjson",
			"nested/../../outside.ndjson",
			"../project-evil/audit.ndjson",
			path.join(outside, "abs.ndjson"),
			"dir-link/sub/audit.ndjson",
			"dangling-dir-link/sub/audit.ndjson",
			"file-link.ndjson",
			"dangling-file-link.ndjson",
			"nested/rel-link.ndjson",
			"hop1",
			"loop-a",
		]) {
			await expect(resolveAuditLogPath(root, { path: bad, source: "shared" }), bad).rejects.toThrow();
		}

		expect(await resolveAuditLogPath(root, { path: "logs/new/audit.ndjson", source: "shared" })).toBe(path.join(root, "logs/new/audit.ndjson"));
		expect(await resolveAuditLogPath(root, { path: ".impeccable/audit.ndjson", source: "shared" })).toBe(path.join(root, ".impeccable/audit.ndjson"));
		expect(await resolveAuditLogPath(root, { path: path.join(root, "logs/abs.ndjson"), source: "shared" })).toBe(path.join(root, "logs/abs.ndjson"));
		expect(await resolveAuditLogPath(root, { path: "internal-link.ndjson", source: "shared" })).toBe(path.join(root, "logs/real.ndjson"));

		for (const source of ["local", "env"] as const) {
			expect(await resolveAuditLogPath(root, { path: "~/trusted.ndjson", source })).toBe(path.join(fakeHome, "trusted.ndjson"));
			expect(await resolveAuditLogPath(root, { path: "../outside.ndjson", source })).toBe(path.join(base, "outside.ndjson"));
			expect(await resolveAuditLogPath(root, { path: path.join(outside, "abs.ndjson"), source })).toBe(path.join(outside, "abs.ndjson"));
		}
	} finally {
		vi.restoreAllMocks();
		await rm(base, { recursive: true, force: true });
	}
});

type EscapeCase = {
	kind: string;
	setup: (ctx: { root: string; outside: string; fakeHome: string }) => Promise<{ auditLog: string; forbidden: string[]; unchanged?: { file: string; content: string } }> | { auditLog: string; forbidden: string[]; unchanged?: { file: string; content: string } };
};

it.each<EscapeCase>([
	{ kind: "tilde", setup: (ctx) => ({ auditLog: "~/escaped-home.ndjson", forbidden: [path.join(ctx.fakeHome, "escaped-home.ndjson")] }) },
	{ kind: "parent-traversal", setup: (ctx) => ({ auditLog: "../escaped-parent.ndjson", forbidden: [path.join(path.dirname(ctx.root), "escaped-parent.ndjson")] }) },
	{ kind: "absolute-outside", setup: (ctx) => ({ auditLog: path.join(ctx.outside, "escaped-abs.ndjson"), forbidden: [path.join(ctx.outside, "escaped-abs.ndjson")] }) },
	{
		kind: "directory-symlink",
		setup: async (ctx) => {
			await symlink(ctx.outside, path.join(ctx.root, "escape-dir"));
			return { auditLog: "escape-dir/nested/escaped-dir-link.ndjson", forbidden: [path.join(ctx.outside, "nested"), path.join(ctx.outside, "nested/escaped-dir-link.ndjson")] };
		},
	},
	{
		kind: "existing-file-symlink",
		setup: async (ctx) => {
			const target = path.join(ctx.outside, "existing-target.ndjson");
			await writeFile(target, "untouched\n");
			await symlink(target, path.join(ctx.root, "existing-link.ndjson"));
			return { auditLog: "existing-link.ndjson", forbidden: [], unchanged: { file: target, content: "untouched\n" } };
		},
	},
	{
		kind: "dangling-file-symlink",
		setup: async (ctx) => {
			const target = path.join(ctx.outside, "escaped-dangling.ndjson");
			await symlink(target, path.join(ctx.root, "dangling-audit.ndjson"));
			return { auditLog: "dangling-audit.ndjson", forbidden: [target] };
		},
	},
])("refuses repo .impeccable/config.json hook.auditLog $kind escape without writing outside project root", async ({ kind, setup }) => {
	const h = await detectorFixture();
	const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-impeccable-audit-escape-")));
	const outside = path.join(scratch, "outside");
	const fakeHome = path.join(scratch, "home");
	await mkdir(outside, { recursive: true });
	await mkdir(fakeHome, { recursive: true });
	vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		const configured = await setup({ root: h.directory, outside, fakeHome });
		await h.config({ hook: { enabled: true, auditLog: configured.auditLog }, fixtureClean: true });
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: `edit-${kind}` })]),
			fauxAssistantMessage("Done"),
		]);
		await h.session.prompt(`Edit with refused ${kind} auditLog`);

		for (const file of configured.forbidden) await missing(file);
		if (configured.unchanged) {
			expect(await readFile(configured.unchanged.file, "utf8")).toBe(configured.unchanged.content);
		}
		if (kind === "tilde") await missing(path.join(h.directory, "~"));
		const feedbackText = JSON.stringify(h.feedback());
		expect(feedbackText).toContain("Refusing repository hook.auditLog");
		expect(h.errors).toEqual([]);
	} finally {
		vi.restoreAllMocks();
		await rm(scratch, { recursive: true, force: true });
		await h.close();
	}
});

it("allows repo .impeccable/config.json hook.auditLog inside the project root", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true, auditLog: "logs/nested/audit.ndjson" }, fixtureClean: true });
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "clean inside" })]),
			fauxAssistantMessage("Done"),
		]);
		await h.session.prompt("Edit with project-confined auditLog");

		const lines = (await readFile(path.join(h.directory, "logs/nested/audit.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(lines.map((entry) => entry.event)).toEqual(["PostToolUse", "Stop"]);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
});

it.each([
	{ source: "local-tilde", mode: "local" as const, target: "tilde" as const },
	{ source: "local-absolute", mode: "local" as const, target: "absolute" as const },
	{ source: "env-tilde", mode: "env" as const, target: "tilde" as const },
	{ source: "env-absolute", mode: "env" as const, target: "absolute" as const },
])("continues to allow trusted $source auditLog destinations outside the project root", async ({ mode, target }) => {
	const h = await detectorFixture();
	const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-impeccable-audit-trusted-")));
	const outside = path.join(scratch, "outside");
	const fakeHome = path.join(scratch, "home");
	await mkdir(outside, { recursive: true });
	await mkdir(fakeHome, { recursive: true });
	const previousLog = process.env.IMPECCABLE_HOOK_LOG;
	vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		const configured = target === "tilde" ? "~/trusted/audit.ndjson" : path.join(outside, "trusted/audit.ndjson");
		const expectedFile = target === "tilde" ? path.join(fakeHome, "trusted/audit.ndjson") : path.join(outside, "trusted/audit.ndjson");
		const blockedShared = path.join(outside, "blocked-shared.ndjson");
		await h.config({ hook: { enabled: true, auditLog: blockedShared }, fixtureClean: true });
		if (mode === "local") {
			delete process.env.IMPECCABLE_HOOK_LOG;
			await writeFile(path.join(h.directory, ".impeccable/config.local.json"), JSON.stringify({ hook: { auditLog: configured } }));
		} else {
			process.env.IMPECCABLE_HOOK_LOG = configured;
		}

		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: `trusted-${mode}-${target}` })]),
			fauxAssistantMessage("Done"),
		]);
		await h.session.prompt(`Edit with trusted ${mode} ${target} auditLog`);

		await missing(blockedShared);
		const lines = (await readFile(expectedFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(lines.map((entry) => entry.event)).toEqual(["PostToolUse", "Stop"]);
		expect(h.errors).toEqual([]);
	} finally {
		vi.restoreAllMocks();
		if (previousLog === undefined) delete process.env.IMPECCABLE_HOOK_LOG;
		else process.env.IMPECCABLE_HOOK_LOG = previousLog;
		await rm(scratch, { recursive: true, force: true });
		await h.close();
	}
});
