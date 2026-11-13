// Publishes the vendored ui-sdk skill as an Impeccable design companion; Impeccable tells the model about it on activation.
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DESIGN_COMPANIONS = Symbol.for("pi-extensions.design-companions");

export interface DesignCompanion {
	name: string;
	/** Absolute path of the vendored SKILL.md. */
	skillPath: string;
	/** Project-relative path of the copy that matches the installed package. */
	installedSkillPath: string;
	summary: string;
}

export const UI_SDK_COMPANION: DesignCompanion = {
	name: "ui-sdk",
	skillPath: fileURLToPath(new URL("./skills/ui-sdk/SKILL.md", import.meta.url)),
	installedSkillPath: "node_modules/@ui-sdk/core/skills/ui-sdk/SKILL.md",
	summary: "headless behaviors for interactive web components: focus, keyboard, popups, selection, drag and drop, ARIA",
};

export default function uiSdkExtension(_pi: ExtensionAPI): void {
	const registry = globalThis as { [DESIGN_COMPANIONS]?: Map<string, DesignCompanion> };
	(registry[DESIGN_COMPANIONS] ??= new Map()).set(UI_SDK_COMPANION.name, UI_SDK_COMPANION);
}
