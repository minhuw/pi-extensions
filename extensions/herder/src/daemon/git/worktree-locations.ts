import path from "node:path";

export function canonicalWorktreeRoot(planDirectory: string): string {
	return path.join(path.resolve(planDirectory), ".herder", "worktrees");
}

export function legacyWorktreeContainer(repoRoot: string): string {
	return `${path.resolve(repoRoot)}-herder-worktrees`;
}

export function legacyWorktreeRoot(repoRoot: string, planName: string): string {
	return path.join(legacyWorktreeContainer(repoRoot), planName);
}

export function allowedWorktreeRoots(repoRoot: string, planDirectory: string, planName: string): string[] {
	return [canonicalWorktreeRoot(planDirectory), legacyWorktreeRoot(repoRoot, planName)];
}

export function isAllowedWorktreeRoot(
	worktreeRoot: string,
	repoRoot: string,
	planDirectory: string,
	planName: string,
): boolean {
	const resolved = path.resolve(worktreeRoot);
	return allowedWorktreeRoots(repoRoot, planDirectory, planName).some((root) => path.resolve(root) === resolved);
}

export function allowedWorktreePaths(
	repoRoot: string,
	planDirectory: string,
	planName: string,
	relative: string,
): string[] {
	return allowedWorktreeRoots(repoRoot, planDirectory, planName).map((root) => path.join(root, relative));
}

export function worktreeRelativeName(branch: string, planName: string, integrationBranch: string): string {
	return branch === integrationBranch ? "integration" : branch.slice(`herder/${planName}/`.length);
}
