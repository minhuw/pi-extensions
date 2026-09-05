/** Explicit dependency guarantees for deterministic fixture graphs. */
export function fixtureDependencies(dependencies: string): string {
	if (dependencies === "none") return "Dependencies: none.";
	return [
		"| Plan | Consumes |",
		"|---|---|",
		...dependencies.split(/\s*,\s*/).map((id) => `| ${id} | Plan ${id}'s reviewed fixture transition is integrated before this target starts. |`),
	].join("\n");
}
