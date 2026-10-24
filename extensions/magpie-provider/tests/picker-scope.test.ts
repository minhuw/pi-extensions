import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hasConfiguredModelScope } from "../picker-scope.ts";

let root: string;
let project: string;
let agent: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "magpie-picker-scope-"));
	project = join(root, "project");
	agent = join(root, "agent");
	mkdirSync(join(project, ".pi"), { recursive: true });
	mkdirSync(agent);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const unavailable = () => { throw new Error("Extension runtime is not initialized."); };
const check = (read: () => unknown = unavailable, argv: string[] = []) => hasConfiguredModelScope(read, argv, project, agent);

it("preserves CLI scopes before initialization and respects the prompt delimiter", () => {
	expect(check(() => ({}), ["--models", "magpie/codex/*:high"])).toBe(true);
	expect(check(() => ({}), ["--", "--models", "prompt text"])).toBe(false);
});

it("uses effective runtime settings, including cleared or project-overridden scopes", () => {
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ enabledModels: ["old/id"] }));
	expect(check(() => ({ enabledModels: ["magpie/codex/gpt-6-astra"] }))).toBe(true);
	expect(check(() => ({ enabledModels: [] }))).toBe(false);
	expect(check(() => ({}))).toBe(false);
});

it.each(["global", "project"])("reads %s startup scopes without writing settings", scope => {
	const path = scope === "global" ? join(agent, "settings.json") : join(project, ".pi", "settings.json");
	const contents = '\uFEFF{"enabledModels":["magpie/codex/gpt-6-astra:high"]}';
	writeFileSync(path, contents);
	expect(check()).toBe(true);
	expect(readFileSync(path, "utf8")).toBe(contents);
});

it("deduplicates when startup settings are absent or have empty scopes", () => {
	expect(check()).toBe(false);
	writeFileSync(join(agent, "settings.json"), '{"enabledModels":[]}');
	writeFileSync(join(project, ".pi", "settings.json"), '{}');
	expect(check()).toBe(false);
});

it("preserves availability when startup scope settings cannot be determined", () => {
	writeFileSync(join(agent, "settings.json"), '{');
	expect(check()).toBe(true);
	expect(check(() => ({ enabledModels: "malformed" }))).toBe(true);
});
