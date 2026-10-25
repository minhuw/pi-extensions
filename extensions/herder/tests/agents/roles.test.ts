import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_ROLE_DIR, loadRole, loadRoles, parseRole, roleSha256 } from "../../src/agents/roles.ts";
import { BUILTIN_ROLES } from "../../src/config.ts";
import { fakeRole } from "../support/fake-runner.ts";

let dir: string;
let builtinDir: string;
let overrideDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "herder-roles-"));
	builtinDir = join(dir, "builtin");
	overrideDir = join(dir, "override");
	mkdirSync(builtinDir);
	mkdirSync(overrideDir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function role(fields: Record<string, string>, body = "You implement one task."): string {
	const all = { name: "worker", description: "Implements one task", write: "true", tools: "[read, edit, write, bash]", model: "inherit", thinking: "inherit", ...fields };
	return `---\n${Object.entries(all).filter(([, value]) => value !== "").map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n${body}\n`;
}

describe("parseRole", () => {
	it("parses inline and block tool lists and the body prompt", () => {
		const inline = parseRole(role({}));
		expect(inline).toMatchObject({ name: "worker", description: "Implements one task", write: true, tools: ["read", "edit", "write", "bash"], model: "inherit", thinking: "inherit", prompt: "You implement one task." });
		const block = parseRole("---\nname: explorer\ndescription: Research\nwrite: false\ntools:\n  - read\n  - grep\nmodel: anthropic/claude-x\nthinking: high\n---\n\nExplore.\n");
		expect(block).toMatchObject({ name: "explorer", write: false, tools: ["read", "grep"], model: "anthropic/claude-x", thinking: "high", prompt: "Explore." });
	});

	it("hashes the resolved definition, matching fakeRole's scheme and keeping inherit literal", () => {
		const parsed = parseRole(role({ tools: "[read, bash]", write: "false", name: "reviewer", description: "reviewer (test)" }, "You are the reviewer."));
		expect(parsed.sha256).toBe(fakeRole("reviewer").sha256);
		expect(parsed.sha256).toBe(roleSha256(parsed));
		expect(parseRole(role({}, "Different prompt.")).sha256).not.toBe(parseRole(role({})).sha256);
		expect(parseRole(role({ thinking: "low" })).sha256).not.toBe(parseRole(role({})).sha256);
	});

	it.each([
		["missing frontmatter", "just a prompt", /missing frontmatter/],
		["malformed YAML", "---\nname: [worker\n---\nbody", /malformed frontmatter/],
		["unknown field", role({ color: "blue" }), /unknown field color/],
		["missing description", role({ description: "" }), /description must be a non-empty string/],
		["non-boolean write", role({ write: "maybe" }), /write must be true or false/],
		["tools not a list", role({ tools: "read" }), /tools must be a list/],
		["read-only role with edit", role({ write: "false" }), /read-only role/],
		["read-only role with a modifier", role({ write: "false", tools: "[-bash]" }), /tool "-bash" must be a plain tool name/],
		["read-only role with a pattern", role({ write: "false", tools: '["*"]' }), /tool "\*" must be a plain tool name/],
		["read-only role with powershell", role({ write: "false", tools: "[read, powershell]" }), /read-only role \(write: false\) may only list read, grep, find, ls, bash; got powershell/],
		["writing role with a modifier", role({ tools: "[read, +edit]" }), /tool "\+edit" must be a plain tool name/],
		["bad model", role({ model: "gpt" }), /model must be "inherit" or provider\/model-id/],
		["bad thinking", role({ thinking: "extreme" }), /thinking must be/],
		["bad name", role({ name: "Worker One" }), /name "Worker One"/],
		["empty body", role({}, ""), /prompt \(body\) is empty/],
	])("rejects %s and names the file", (_label, text, message) => {
		expect(() => parseRole(text, "/roles/x.md")).toThrow(message);
		expect(() => parseRole(text, "/roles/x.md")).toThrow(/Invalid Herder role \/roles\/x\.md/);
	});
});

describe("loadRoles", () => {
	it("lets an override replace a built-in role entirely and add new roles", () => {
		writeFileSync(join(builtinDir, "worker.md"), role({}));
		writeFileSync(join(builtinDir, "reviewer.md"), role({ name: "reviewer", write: "false", tools: "[read]" }, "Review."));
		writeFileSync(join(overrideDir, "worker.md"), role({ tools: "[read, write]", model: "openai/gpt-x" }, "My worker."));
		writeFileSync(join(overrideDir, "auditor.md"), role({ name: "auditor", write: "false", tools: "[read]" }, "Audit."));
		writeFileSync(join(overrideDir, "notes.txt"), "ignored");
		const builtin = loadRoles({ builtinDir, overrideDir: join(dir, "absent") });
		const roles = loadRoles({ builtinDir, overrideDir });
		expect([...roles.keys()].sort()).toEqual(["auditor", "reviewer", "worker"]);
		expect(roles.get("worker")).toMatchObject({ tools: ["read", "write"], model: "openai/gpt-x", prompt: "My worker." });
		expect(roles.get("worker")!.sha256).not.toBe(builtin.get("worker")!.sha256);
		expect(roles.get("reviewer")).toEqual(builtin.get("reviewer"));
		expect(loadRole("auditor", { builtinDir, overrideDir }).prompt).toBe("Audit.");
	});

	it("reports unknown roles, name mismatches, and malformed files with their path", () => {
		writeFileSync(join(builtinDir, "worker.md"), role({}));
		expect(() => loadRole("ghost", { builtinDir, overrideDir })).toThrow(/Unknown Herder role "ghost"; known roles: worker/);
		writeFileSync(join(overrideDir, "helper.md"), role({ name: "other" }));
		expect(() => loadRoles({ builtinDir, overrideDir })).toThrow(`Invalid Herder role ${join(overrideDir, "helper.md")}: name "other" does not match the file name`);
		rmSync(join(overrideDir, "helper.md"));
		writeFileSync(join(overrideDir, "worker.md"), role({ write: "nope" }));
		expect(() => loadRoles({ builtinDir, overrideDir })).toThrow(join(overrideDir, "worker.md"));
	});

	const hasBuiltins = existsSync(BUILTIN_ROLE_DIR) && readdirSync(BUILTIN_ROLE_DIR).some((file) => file.endsWith(".md"));
	it.skipIf(!hasBuiltins)("loads the shipped built-in roles", () => {
		const roles = loadRoles({ overrideDir: join(dir, "absent") });
		expect([...roles.keys()].sort()).toEqual([...BUILTIN_ROLES].sort());
		for (const name of ["worker", "resolver", "curator"]) expect(roles.get(name)!.write).toBe(true);
		for (const name of ["reviewer", "verifier", "explorer"]) expect(roles.get(name)!.write).toBe(false);
	});
});
