import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function scoped(settings: unknown): boolean {
	if (!settings || typeof settings !== "object") return true;
	const value = (settings as { enabledModels?: unknown }).enabledModels;
	return value !== undefined && (!Array.isArray(value) || value.length > 0);
}

/** Preserve Pi's scope matching before and after its extension runtime is initialized. */
export function hasConfiguredModelScope(
	readSettings: () => unknown,
	argv: readonly string[] = process.argv.slice(2),
	cwd = process.cwd(),
	agentDir = getAgentDir(),
): boolean {
	const end = argv.indexOf("--");
	if ((end < 0 ? argv : argv.slice(0, end)).includes("--models")) return true;
	try { return scoped(readSettings()); }
	catch {
		// getSettings is unavailable during initial discovery. Read only the scope
		// setting; do not migrate settings or make assumptions about project trust.
		for (const path of [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")]) {
			try {
				if (scoped(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")))) return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
			}
		}
		return false;
	}
}
