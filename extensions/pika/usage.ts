import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

/** Session entry, never sent to the model, recording that the user ran a command, template, or skill. */
export const COMMAND_ENTRY_TYPE = "pi-extensions.command";

export interface CommandEntry {
	/** The name without its leading slash; a skill's name without `skill:`. */
	command: string;
	kind: "extension" | "template" | "skill";
	/** The `extensions/<dir>` directory that ships it. */
	extension?: string;
}

/** The `<dir>` of the last `/extensions/<dir>/` in a path, if any. */
export function extensionDir(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const matches = [...path.matchAll(/[\\/]extensions[\\/]([^\\/]+)[\\/]/g)];
	return matches.at(-1)?.[1];
}

/** The entry for typed text that runs a prompt template or skill, or undefined for anything else. */
export function commandEntry(text: string, commands: SlashCommandInfo[]): CommandEntry | undefined {
	const name = /^\/(\S+)/.exec(text)?.[1];
	if (!name) return undefined;
	const skill = name.startsWith("skill:");
	const info = commands.find((command) => command.name === name && command.source === (skill ? "skill" : "prompt"));
	if (!info) return undefined;
	const extension = extensionDir(info.sourceInfo?.path);
	return { command: skill ? name.slice("skill:".length) : name, kind: skill ? "skill" : "template", ...(extension ? { extension } : {}) };
}

/** Records each prompt template or skill the user types; extension commands record themselves in their handlers. */
export function usageExtension(pi: ExtensionAPI): void {
	pi.on("input", (event) => {
		if (event.source === "extension") return undefined;
		try {
			const entry = commandEntry(event.text, pi.getCommands());
			if (entry) pi.appendEntry<CommandEntry>(COMMAND_ENTRY_TYPE, entry);
		} catch {
			// Telemetry never stands in the way of the user's input.
		}
		return undefined;
	});
}
