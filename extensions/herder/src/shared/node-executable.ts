import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function executableFile(candidate: string): string | null {
	try {
		const resolved = fs.realpathSync(candidate);
		if (!fs.statSync(resolved).isFile()) return null;
		if (process.platform !== "win32") fs.accessSync(resolved, fs.constants.X_OK);
		return resolved;
	} catch {
		return null;
	}
}

/** Resolve a live Node executable even when a package-manager upgrade removed process.execPath. */
export function resolveNodeExecutable(
	preferred = process.execPath,
	environment: NodeJS.ProcessEnv = process.env,
): string {
	const direct = executableFile(preferred);
	if (direct) return direct;
	const names = process.platform === "win32" ? ["node.exe", "node.cmd", "node"] : ["node"];
	for (const directory of (environment.PATH || environment.Path || environment.path || "").split(path.delimiter).filter(Boolean)) {
		for (const name of names) {
			const discovered = executableFile(path.join(directory, name));
			if (discovered) return discovered;
		}
	}
	throw new Error(`Node executable is unavailable: ${preferred}`);
}
