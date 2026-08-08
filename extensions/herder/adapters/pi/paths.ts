import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

function assertInsideRepository(canonicalRepo: string, candidate: string, allowRoot = false): void {
	const relative = path.relative(canonicalRepo, candidate);
	if ((!allowRoot && !relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Herder plan directory must stay inside the repository: ${candidate}`);
	}
}

export function resolvePlanDirectory(repoRoot: string, input: string): string {
	const canonicalRepo = realpathSync(repoRoot);
	const candidate = path.resolve(canonicalRepo, input);
	let canonicalPlan: string;
	try {
		canonicalPlan = realpathSync(candidate);
	} catch {
		throw new Error(`Herder plan directory does not exist: ${candidate}`);
	}
	if (!statSync(canonicalPlan).isDirectory()) throw new Error(`Herder plan path is not a directory: ${canonicalPlan}`);
	assertInsideRepository(canonicalRepo, canonicalPlan);
	return canonicalPlan;
}

export function resolvePlanDirectoryTarget(repoRoot: string, input: string): string {
	const canonicalRepo = realpathSync(repoRoot);
	const lexicalTarget = path.resolve(canonicalRepo, input);
	assertInsideRepository(canonicalRepo, lexicalTarget);

	let existing = lexicalTarget;
	const missing: string[] = [];
	while (!existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) throw new Error(`Cannot resolve Herder plan directory: ${lexicalTarget}`);
		missing.push(path.basename(existing));
		existing = parent;
	}
	const canonicalExisting = realpathSync(existing);
	assertInsideRepository(canonicalRepo, canonicalExisting, true);
	if (!statSync(canonicalExisting).isDirectory()) throw new Error(`Herder plan path is not a directory: ${canonicalExisting}`);
	const target = path.join(canonicalExisting, ...missing.reverse());
	assertInsideRepository(canonicalRepo, target);
	return target;
}
