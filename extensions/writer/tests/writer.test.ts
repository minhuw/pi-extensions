import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildWriterSkillPrompt,
	launchWriterWorkflow,
	registerWriterExtension,
	WRITER_SKILLS_DIR,
	WRITER_WORKFLOWS,
	type WriterSkill,
} from "../index.ts";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(extensionRoot, "../..");

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function context(options: {
	onWait?: () => void;
	onNotify?: (message: string, level: string) => void;
} = {}): ExtensionCommandContext {
	return {
		waitForIdle: async () => {
			options.onWait?.();
		},
		ui: {
			notify: (message: string, level: string) => {
				options.onNotify?.(message, level);
			},
		},
	} as unknown as ExtensionCommandContext;
}

function piFor(options: {
	onUserMessage?: (message: string) => void;
	onCommand?: (name: string, command: RegisteredCommand) => void;
	onDiscover?: (handler: () => Promise<{ skillPaths?: string[] }>) => void;
} = {}): ExtensionAPI {
	return {
		on: (event: string, handler: () => Promise<{ skillPaths?: string[] }>) => {
			if (event === "resources_discover") options.onDiscover?.(handler);
		},
		registerCommand: (name: string, command: RegisteredCommand) => {
			options.onCommand?.(name, command);
		},
		sendUserMessage: (message: string) => {
			options.onUserMessage?.(message);
		},
	} as unknown as ExtensionAPI;
}

async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "writer-extension-"));
	const skillDirectory = path.join(root, "skills", "polish");
	await mkdir(skillDirectory, { recursive: true });
	await writeFile(path.join(skillDirectory, "SKILL.md"), `---
name: polish
description: Polish academic text.
---

# Academic Text Polish

Rewrite the excerpt for conference style.
`);
	return root;
}

test("package and README register every writer workflow", async () => {
	const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
	const rootReadme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
	const readme = await readFile(path.join(extensionRoot, "README.md"), "utf8");
	assert.ok(manifest.pi.extensions.includes("./extensions/writer/index.ts"));
	assert.match(rootReadme, /\[Writer\]\(extensions\/writer\/README\.md\)/);
	assert.match(readme, /\[claude-writer\]\(https:\/\/github.com\/minhuw\/claude-writer\)/);
	assert.deepEqual(
		WRITER_WORKFLOWS.map((workflow) => workflow.command),
		[
			"conference-reviewer",
			"evaluate",
			"grammar-checker",
			"paper-validator",
			"polish",
			"selection",
			"summary",
			"validation",
		],
	);
	for (const workflow of WRITER_WORKFLOWS) {
		assert.match(readme, new RegExp(`^\\| \`/${workflow.command}\` \\|`, "m"));
		assert.match(readme, new RegExp(`^/${workflow.command}`, "m"));
	}
});

test("packaged skills keep the original claude-writer names and bodies", async () => {
	assert.equal(WRITER_SKILLS_DIR, path.join(extensionRoot, "skills"));
	for (const workflow of WRITER_WORKFLOWS) {
		const contents = await readFile(path.join(extensionRoot, "skills", workflow.skill, "SKILL.md"), "utf8");
		assert.match(contents, new RegExp(`^name: ${workflow.skill}$`, "m"));
		assert.match(contents, /^description: This skill should be used when /m);
		assert.doesNotMatch(contents, /claude plugin|claude code/i);
	}
});

test("writer prompts preserve the packaged skill and trailing arguments", async () => {
	const root = await fixture();
	try {
		const prompt = await buildWriterSkillPrompt("polish", "  introduction.tex  ", root);
		assert.match(prompt, /^<skill name="polish" location=".*SKILL\.md">/);
		assert.match(prompt, /References are relative to .*skills\/polish\./);
		assert.match(prompt, /# Academic Text Polish/);
		assert.doesNotMatch(prompt, /description: Polish academic text/);
		assert.match(prompt, /\n\nintroduction\.tex$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writer commands wait for idle, then inject the selected skill", async () => {
	const root = await fixture();
	const commands = new Map<string, RegisteredCommand>();
	const messages: string[] = [];
	let waited = false;
	let discover: (() => Promise<{ skillPaths?: string[] }>) | undefined;
	try {
		registerWriterExtension(
			piFor({
				onCommand: (name, command) => {
					commands.set(name, command);
				},
				onUserMessage: (message) => {
					messages.push(message);
				},
				onDiscover: (handler) => {
					discover = handler;
				},
			}),
			root,
		);
		assert.deepEqual([...commands.keys()], WRITER_WORKFLOWS.map((workflow) => workflow.command));
		assert.equal((await discover?.())?.skillPaths?.[0], path.join(root, "skills"));
		await commands.get("polish")?.handler("the abstract", context({
			onWait: () => {
				waited = true;
			},
		}));
		assert.equal(waited, true);
		assert.equal(messages.length, 1);
		assert.match(messages[0] ?? "", /# Academic Text Polish/);
		assert.match(messages[0] ?? "", /\n\nthe abstract$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writer command failures surface as UI errors", async () => {
	const notifications: Array<{ message: string; level: string }> = [];
	const commands = new Map<string, RegisteredCommand>();
	registerWriterExtension(
		piFor({
			onCommand: (name, command) => {
				commands.set(name, command);
			},
		}),
		path.join(os.tmpdir(), "writer-missing-extension"),
	);
	await commands.get("summary")?.handler("", context({
		onNotify: (message, level) => {
			notifications.push({ message, level });
		},
	}));
	assert.equal(notifications[0]?.level, "error");
	assert.match(notifications[0]?.message ?? "", /ENOENT|no such file/i);
});

test("launchWriterWorkflow rejects unknown skills through the prompt builder", async () => {
	await assert.rejects(
		() => buildWriterSkillPrompt("not-a-skill" as WriterSkill),
		/Unknown writer skill/,
	);
	const sent: string[] = [];
	await launchWriterWorkflow(
		{
			sendUserMessage: (message) => {
				if (typeof message !== "string") throw new Error("expected text prompt");
				sent.push(message);
			},
		},
		{ waitForIdle: async () => {} },
		"evaluate",
		"",
	);
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /# Academic Text Evaluator/);
});
