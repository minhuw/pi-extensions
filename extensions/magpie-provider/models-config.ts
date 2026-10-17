import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function assertNativeCatalog(): void {
	let config: { providers?: Record<string, unknown> } | null;
	try {
		const contents = readFileSync(join(getAgentDir(), "models.json"), "utf8");
		// Match Pi's unexported parser: BOM, // comments and trailing commas (not block comments).
		config = JSON.parse(contents.replace(/^\uFEFF/, "")
			.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, match => match[0] === '"' ? match : "")
			.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? match));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new Error("Magpie cannot safely read models.json. Check that the standard Pi models.json is readable and valid JSON with optional // comments and trailing commas.");
	}
	if (config?.providers && Object.hasOwn(config.providers, "magpie")) {
		throw new Error("Magpie requires one configuration owner. Remove providers.magpie from the standard Pi models.json, including metadata-only overlays, and stop adapter config-sync. Configure this native extension through /login magpie or MAGPIE environment variables instead.");
	}
}
