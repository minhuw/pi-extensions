import { sanitize, type Project, type TerminalInfo } from "../contract";
import { within } from "../files";
import { OTHER } from "./store";

/** The innermost project holding `path`, if any. */
export function innermostProject(projects: readonly Pick<Project, "path">[], path: string | undefined): string | undefined {
	if (!path) return undefined;
	let best: string | undefined;
	for (const project of projects) if (within(path, project.path) && (!best || project.path.length > best.length)) best = project.path;
	return best;
}

/**
 * The project a terminal belongs to: the innermost one holding its pi session's cwd (as its bridge reported it),
 * else the one holding the terminal's own cwd; else the node's "Other" card.
 */
export function projectOfTerminal(projects: readonly Pick<Project, "path">[], terminal: TerminalInfo): string {
	const session = sanitize(terminal.status?.bridge?.session?.cwd);
	return innermostProject(projects, session || undefined) ?? innermostProject(projects, terminal.cwd) ?? OTHER;
}

/** A project's name for its card. */
export function projectName(projects: readonly Project[], project: string): string {
	if (project === OTHER) return "Other";
	const found = projects.find((item) => item.path === project);
	return found ? sanitize(found.name) : (project.slice(project.lastIndexOf("/") + 1) || project);
}
