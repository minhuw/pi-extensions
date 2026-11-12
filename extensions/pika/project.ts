import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { credentialsRegistry } from "./credentials.ts";
import { inspectRepository, PROJECT_CONFIG, type ProjectConfig, type RepositoryState, validProjectName } from "./repository.ts";

const SESSION_LINK_TYPE = "pi-extensions.session-link";
const NAME_CHOICE = "None of these: I'll type a project name";

// Module copies loaded for other cwds share this state, so it lives on globalThis.
const SHARED = Symbol.for("pi-extensions.pika.project");
interface Shared {
	/** Main checkouts whose question is open in this process. */
	asking: Set<string>;
	/** Main checkouts whose question was dismissed; this process does not ask again. */
	declined: Set<string>;
}
const global = globalThis as { [SHARED]?: Shared };
const shared = (): Shared => global[SHARED] ??= { asking: new Set(), declined: new Set() };

/** Called after the user saves a repository's identity, with the context of the session that asked. */
export type IdentityChanged = (ctx: ExtensionContext) => Promise<void>;

/** Creates `dir` with a `.gitignore` of `*`, never touching a `.gitignore` that exists or the project's own. */
export async function ensureIgnoredDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
}

/** Writes `<checkout>/.pi/pika/project.json` whole, so a reader never sees half of it; returns its path. */
export async function writeProjectConfig(checkout: string, config: ProjectConfig): Promise<string> {
	const file = join(checkout, PROJECT_CONFIG);
	await ensureIgnoredDir(dirname(file));
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temp, `${JSON.stringify(config, null, "\t")}\n`);
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	return file;
}

/** How pika files the repository: under a remote's URL, or under a name on this device. */
export function describeIdentity(state: RepositoryState): string {
	const { project, repository } = state.info;
	if (!project) return "it is not in a git repository pika can name";
	const where = repository ? `project ${project}, identified by ${repository}` : `project ${project} on this device only (it has no remote URL)`;
	const why = state.config && state.checkout ? `saved in ${join(state.checkout, PROJECT_CONFIG)}` : "from its remotes: origin, else the only remote";
	return `${where}; ${why}`;
}

/** Asks for a project name; Enter keeps `fallback`. Undefined when dismissed. */
async function askName(ui: ExtensionUIContext, folder: string, fallback: string): Promise<string | undefined> {
	// The question comes first: Orca and the pika web UI show this title on one truncated line.
	let title = `pika: project name for ${folder}? (Enter = "${fallback}") Your sessions and memory here are grouped under it.`;
	for (;;) {
		const answer = await ui.input(title, fallback);
		if (answer === undefined) return undefined;
		const typed = answer.trim() || fallback;
		const name = validProjectName(typed);
		if (name) return name;
		title = `pika: "${typed}" can't be a project name (no / or \\, not . or .., at most 255 bytes). Project name for ${folder}? (Enter = "${fallback}")`;
	}
}

/**
 * Asks which remote identifies the repository, or for a name when none does. Undefined when dismissed. A remote keeps
 * a saved name; a name pins the repository to no remote, so remotes added later do not move it.
 */
export async function askIdentity(ui: ExtensionUIContext, state: RepositoryState, current?: string): Promise<ProjectConfig | undefined> {
	const folder = state.folder!;
	const candidates = state.remotes.filter((remote) => remote.url);
	if (candidates.length) {
		const title = current ? `pika: which remote identifies ${folder}? (now: ${current})`
			: state.question === "stale" ? `pika: which remote identifies ${folder} now? The saved one, "${state.config?.remote}", is gone or has no web URL.`
			: `pika: which remote identifies ${folder}? It has several and none is "origin"; your sessions and memory here are grouped under its URL.`;
		const options = candidates.map((remote) => `${remote.name}  ${remote.url}`);
		const choice = await ui.select(title, [...options, NAME_CHOICE]);
		if (choice === undefined) return undefined;
		const index = options.indexOf(choice);
		if (index >= 0) return { remote: candidates[index]!.name, ...(state.config?.project ? { project: state.config.project } : {}) };
	}
	const name = await askName(ui, folder, state.config?.project ?? folder);
	return name === undefined ? undefined : { remote: null, project: name };
}

/** Saves the answer and reports the identity it gives; a failed write changes nothing. */
async function save(ctx: ExtensionContext, cwd: string, checkout: string, config: ProjectConfig, changed: IdentityChanged): Promise<void> {
	let file: string;
	try {
		file = await writeProjectConfig(checkout, config);
	} catch (error) {
		ctx.ui.notify(`pika: could not save ${join(checkout, PROJECT_CONFIG)}: ${error instanceof Error ? error.message : String(error)}. Nothing changed.`, "error");
		return;
	}
	const state = await inspectRepository(cwd);
	await changed(ctx).catch(() => undefined);
	ctx.ui.notify([
		`pika: this repository is now ${describeIdentity(state)}.`,
		`Saved to ${file}, which git ignores; /pika project changes it. Uploads and memory tools use it now; a memory index this session already loaded stays until a new session.`,
	].join("\n"), "info");
}

/** `/pika project`: shows how pika files this repository and, with a UI, asks again. */
export async function projectCommand(ctx: ExtensionCommandContext, changed: IdentityChanged): Promise<void> {
	const cwd = ctx.sessionManager.getCwd() || ctx.cwd;
	const state = await inspectRepository(cwd);
	const current = describeIdentity(state);
	if (!state.info.project) { ctx.ui.notify(`pika: ${cwd} is not in a git repository pika can name, so it has no project.`, "info"); return; }
	if (!state.checkout) {
		ctx.ui.notify(`pika: this repository is ${current}. It has no main checkout (a bare repository or a submodule) to keep ${PROJECT_CONFIG} in.`, "info");
		return;
	}
	if (!ctx.hasUI) { ctx.ui.notify(`pika: this repository is ${current}. Run /pika project in the TUI to change it.`, "info"); return; }
	shared().declined.delete(state.checkout);
	const config = await askIdentity(ctx.ui, state, current);
	if (!config) { ctx.ui.notify("pika: nothing changed.", "info"); return; }
	await save(ctx, cwd, state.checkout, config, changed);
}

/**
 * Asks a top-level TUI session's user for the repository's identity when git leaves it open: several remotes and none
 * named origin, no remote with a web URL, or a saved remote that is gone. It asks once per repository at a time, and a
 * dismissed question waits for the next pi process; sessions without a UI, child sessions, and sessions pika does not
 * upload never ask, and keep the identity the remotes give.
 */
export function projectExtension(pi: ExtensionAPI, changed: IdentityChanged): void {
	let ended = false;

	async function ask(ctx: ExtensionContext, cwd: string): Promise<void> {
		const state = await inspectRepository(cwd);
		const checkout = state.checkout;
		if (!state.question || !checkout || ended) return;
		const { asking, declined } = shared();
		if (asking.has(checkout) || declined.has(checkout)) return;
		asking.add(checkout);
		try {
			const config = await askIdentity(ctx.ui, state);
			if (ended) return;
			if (!config) {
				declined.add(checkout);
				ctx.ui.notify(`pika: this repository stays ${describeIdentity(state)} for now. pika asks again when pi next starts here; /pika project answers now.`, "info");
				return;
			}
			await save(ctx, cwd, checkout, config, changed);
		} finally {
			asking.delete(checkout);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		ended = false;
		if (ctx.mode !== "tui") return;
		if (ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE)) return;
		const cwd = ctx.sessionManager.getCwd() || ctx.cwd;
		const credentials = credentialsRegistry().current;
		if (!credentials || credentials.isExcluded(cwd)) return;
		// Not awaited: the session starts at once, and the question opens once git answered.
		void ask(ctx, cwd).catch(() => undefined);
	});

	pi.on("session_shutdown", () => { ended = true; });
}
