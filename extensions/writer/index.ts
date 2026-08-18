import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	stripFrontmatter,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_ENTRY = fileURLToPath(import.meta.url);
export const WRITER_EXTENSION_ROOT = path.dirname(EXTENSION_ENTRY);
export const WRITER_SKILLS_DIR = path.join(WRITER_EXTENSION_ROOT, "skills");

export const WRITER_WORKFLOWS = [
	{
		command: "conference-reviewer",
		skill: "conference-reviewer",
		description: "Review a paper as a top-tier systems conference reviewer.",
	},
	{
		command: "evaluate",
		skill: "evaluate",
		description: "Score research-paper text for flow, structure, and clarity.",
	},
	{
		command: "grammar-checker",
		skill: "grammar-checker",
		description: "Scan and fix typos, grammar, and awkward academic phrasing.",
	},
	{
		command: "paper-validator",
		skill: "paper-validator",
		description: "Review a paper draft for weaknesses, evidence gaps, and structure.",
	},
	{
		command: "polish",
		skill: "polish",
		description: "Polish academic text for grammar, fluency, and conference style.",
	},
	{
		command: "selection",
		skill: "selection",
		description: "Propose scored word or phrase candidates for a placeholder.",
	},
	{
		command: "summary",
		skill: "summary",
		description: "Summarize research-paper text while preserving technical claims.",
	},
	{
		command: "validation",
		skill: "validation",
		description: "Validate whether a marked word or phrase fits academic usage.",
	},
] as const;

export type WriterSkill = (typeof WRITER_WORKFLOWS)[number]["skill"];

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function xmlAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function writerWorkflow(skill: WriterSkill) {
	const workflow = WRITER_WORKFLOWS.find((candidate) => candidate.skill === skill);
	if (!workflow) throw new Error(`Unknown writer skill: ${skill}`);
	return workflow;
}

export function writerSkillDirectory(skill: WriterSkill, extensionRoot = WRITER_EXTENSION_ROOT): string {
	return path.join(extensionRoot, "skills", skill);
}

export function writerSkillFile(skill: WriterSkill, extensionRoot = WRITER_EXTENSION_ROOT): string {
	return path.join(writerSkillDirectory(skill, extensionRoot), "SKILL.md");
}

export async function buildWriterSkillPrompt(
	skill: WriterSkill,
	argumentsText = "",
	extensionRoot = WRITER_EXTENSION_ROOT,
): Promise<string> {
	const workflow = writerWorkflow(skill);
	const skillDirectory = writerSkillDirectory(skill, extensionRoot);
	const skillFile = writerSkillFile(skill, extensionRoot);
	const body = stripFrontmatter(await readFile(skillFile, "utf8")).trim();
	if (!body) throw new Error(`Writer workflow ${skill} has no instructions.`);
	const block = `<skill name="${xmlAttribute(workflow.skill)}" location="${xmlAttribute(skillFile)}">\nReferences are relative to ${skillDirectory}.\n\n${body}\n</skill>`;
	return argumentsText.trim() ? `${block}\n\n${argumentsText.trim()}` : block;
}

export async function launchWriterWorkflow(
	pi: Pick<ExtensionAPI, "sendUserMessage">,
	ctx: Pick<ExtensionCommandContext, "waitForIdle">,
	skill: WriterSkill,
	argumentsText: string,
	extensionRoot = WRITER_EXTENSION_ROOT,
): Promise<{ submitted: true }> {
	await ctx.waitForIdle();
	pi.sendUserMessage(await buildWriterSkillPrompt(skill, argumentsText, extensionRoot));
	return { submitted: true };
}

export function registerWriterExtension(pi: ExtensionAPI, extensionRoot = WRITER_EXTENSION_ROOT): void {
	pi.on("resources_discover", async () => ({
		skillPaths: [path.join(extensionRoot, "skills")],
	}));

	for (const workflow of WRITER_WORKFLOWS) {
		pi.registerCommand(workflow.command, {
			description: workflow.description,
			handler: async (args, ctx) => {
				try {
					await launchWriterWorkflow(pi, ctx, workflow.skill, args, extensionRoot);
				} catch (error) {
					ctx.ui.notify(message(error), "error");
				}
			},
		});
	}
}

export default function (pi: ExtensionAPI): void {
	registerWriterExtension(pi);
}
