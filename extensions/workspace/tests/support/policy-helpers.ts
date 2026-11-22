import {
	evaluatePathAccess,
	extractAgentBrowserWriteTargets,
	extractAgentDesktopWriteTargets,
	inspectBashCommand,
	normalizeAgentDesktopCwd,
	resolveLiteralPath,
} from "../../policy.ts";

/** Filters resolved or literal candidate paths to those `evaluatePathAccess` treats as external. */
export function filterExternalPaths(targetPaths: readonly string[], cwd: string): string[] {
	const external: string[] = [];
	for (const targetPath of targetPaths) {
		const check = evaluatePathAccess({ targetPath, cwd, literal: true });
		if (!check.allowed) {
			external.push(check.resolvedPath);
		}
	}
	return [...new Set(external)];
}

/** Collects write target paths from `inspectBashCommand`. */
export function bashWritePaths(command: string, cwd: string, projectCwd?: string): string[] {
	return inspectBashCommand(command, cwd, projectCwd).writeTargets.map((target) => target.path);
}

/** Collects external write target paths from `inspectBashCommand` + `evaluatePathAccess`. */
export function bashExternalWritePaths(command: string, cwd: string, baseCwd?: string): string[] {
	return filterExternalPaths(bashWritePaths(command, baseCwd ?? cwd, cwd), cwd);
}

/** Collects external paths from `extractAgentBrowserWriteTargets` + optional `cwd` + `evaluatePathAccess`. */
export function agentBrowserExternalPaths(
	argv: readonly string[],
	projectCwd: string,
	rawCwd?: string,
): string[] {
	const hasCwd = typeof rawCwd === "string" && rawCwd.length > 0;
	const targetCwd = hasCwd ? resolveLiteralPath(rawCwd, projectCwd) : projectCwd;
	const targets = [...(hasCwd ? [rawCwd] : []), ...extractAgentBrowserWriteTargets(argv, targetCwd)];
	return filterExternalPaths(targets, projectCwd);
}

/** Collects external paths from `extractAgentDesktopWriteTargets` + normalized `cwd` + `evaluatePathAccess`. */
export function agentDesktopExternalPaths(
	argv: readonly string[],
	projectCwd: string,
	rawCwd?: string,
): string[] {
	const normalizedCwd = normalizeAgentDesktopCwd(rawCwd);
	const targetCwd = normalizedCwd ? resolveLiteralPath(normalizedCwd, projectCwd) : projectCwd;
	return filterExternalPaths(extractAgentDesktopWriteTargets(argv, targetCwd), projectCwd);
}
