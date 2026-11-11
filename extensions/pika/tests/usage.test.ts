import { expect, it } from "vitest";
import type { ExtensionAPI, InputEvent, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { COMMAND_ENTRY_TYPE, extensionDir, usageExtension } from "../usage.ts";

const info = (name: string, source: SlashCommandInfo["source"], path?: string): SlashCommandInfo =>
	({ name, source, ...(path ? { sourceInfo: { path, source: "local", scope: "user", origin: "package" } } : {}) }) as SlashCommandInfo;

const COMMANDS = [
	info("review", "prompt", "/home/u/pi-extensions/extensions/quality/prompts/review.md"),
	info("loose", "prompt", "/home/u/.pi/agent/prompts/loose.md"),
	info("bare", "prompt"),
	info("skill:herder", "skill", "/home/u/pi-extensions/extensions/herder/skills/herder/SKILL.md"),
	info("pika", "extension", "/home/u/pi-extensions/extensions/pika/index.ts"),
];

/** The input handler usage registers and the entries it appends, without a pi runtime. */
function hook(commands: SlashCommandInfo[] = COMMANDS) {
	const entries: Array<{ type: string; data: unknown }> = [];
	let handler: ((event: InputEvent) => unknown) | undefined;
	usageExtension({
		on: (event: string, fn: (event: InputEvent) => unknown) => { if (event === "input") handler = fn; },
		getCommands: () => commands,
		appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
	} as unknown as ExtensionAPI);
	const input = (text: string, source: InputEvent["source"] = "interactive") => handler!({ type: "input", text, source });
	return { entries, input };
}

it("records a prompt template with the extension that ships it", () => {
	const { entries, input } = hook();
	expect(input("/review the parser")).toBeUndefined();
	expect(input("/loose", "rpc")).toBeUndefined();
	expect(input("/bare")).toBeUndefined();
	expect(entries).toEqual([
		{ type: COMMAND_ENTRY_TYPE, data: { command: "review", kind: "template", extension: "quality" } },
		{ type: COMMAND_ENTRY_TYPE, data: { command: "loose", kind: "template" } },
		{ type: COMMAND_ENTRY_TYPE, data: { command: "bare", kind: "template" } },
	]);
});

it("records a skill by its name without the skill: prefix", () => {
	const { entries, input } = hook();
	expect(input("/skill:herder start a run")).toBeUndefined();
	expect(entries).toEqual([{ type: COMMAND_ENTRY_TYPE, data: { command: "herder", kind: "skill", extension: "herder" } }]);
});

it("ignores unknown slash text, plain text, and extension commands", () => {
	const { entries, input } = hook();
	for (const text of ["/nope", "/skill:missing", "/", " /review", "please /review this", "", "/pika status"]) expect(input(text)).toBeUndefined();
	expect(entries).toEqual([]);
});

it("ignores input that an extension sent", () => {
	const { entries, input } = hook();
	expect(input("/review", "extension")).toBeUndefined();
	expect(input("/skill:herder", "extension")).toBeUndefined();
	expect(entries).toEqual([]);
});

it("never throws when the command list cannot be read", () => {
	const { entries, input } = hook(null as never);
	expect(input("/review")).toBeUndefined();
	expect(entries).toEqual([]);
});

it("takes the directory after the last extensions segment", () => {
	expect(extensionDir("/a/extensions/writer/prompts/x.md")).toBe("writer");
	expect(extensionDir("C:\\a\\extensions\\quality\\prompts\\x.md")).toBe("quality");
	expect(extensionDir("/a/node_modules/pkg/extensions/goal/index.ts")).toBe("goal");
	expect(extensionDir("/home/u/.pi/agent/extensions/file.ts")).toBeUndefined();
	expect(extensionDir("/a/pi-extensions/prompts/x.md")).toBeUndefined();
	expect(extensionDir(undefined)).toBeUndefined();
});
