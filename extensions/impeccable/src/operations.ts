import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runEngine, type EngineRunResult, type RunEngineOptions } from "./engine.ts";
import { getSkillDir } from "./resources.ts";
import { atomicWrite, hookStatus, object, optionalText, parseTargetArgs, physicalPath, readConfigs, resolveDirectory, resolveProject, saveConfig, serialized, withGitExcludeMutation, withManagedFileMutation } from "./project.ts";

export interface IntegrationMetadata { adapter: "pi"; engineRun: boolean; operation: string; root: string; [key: string]: unknown }
export type OperationResult = EngineRunResult & { integration?: IntegrationMetadata };
const PIN_MARKER = "<!-- pi-impeccable-owned-prompt:v1 -->";
const execFileAsync = promisify(execFile);
/** Establish local-config privacy before any real local-config commit. */
async function excludeLocalConfig(root: string, signal: AbortSignal | undefined, committed: string[]): Promise<void> {
	await withGitExcludeMutation(root, signal, async (file, repository) => {
		if (!file || !repository) return;
		const physicalRepository = await resolveDirectory(repository);
		const config = await physicalPath(path.join(root, ".impeccable/config.local.json"));
		const relative = path.relative(physicalRepository, config);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || /[\r\n]/.test(relative)) throw new Error(`${config}: cannot establish local-config privacy inside repository ${physicalRepository}; left unchanged`);
		signal?.throwIfAborted();
		const gitOptions = { cwd: physicalRepository, timeout: 2000, maxBuffer: 64 * 1024, signal };
		const tracked = await execFileAsync("git", ["--literal-pathspecs", "ls-files", "--cached", "-z", "--", relative], gitOptions);
		signal?.throwIfAborted();
		if (tracked.stdout) throw new Error(`${config}: already tracked by Git; an exclusion cannot make it private. Review its tracked status manually; left unchanged`);
		// Anchor to the physical destination, including missing files through
		// existing ancestors. The shared exclude file serves other apps too.
		const pattern = `/${relative.split(path.sep).join("/").replace(/[\\*?\[\]]/g, "\\$&")}`;
		const text = await optionalText(file, signal);
		if (!text?.split(/\r?\n/).includes(pattern)) await atomicWrite(file, `${text ?? ""}${text && !text.endsWith("\n") ? "\n" : ""}${pattern}\n`, signal, () => committed.push(file));
		// Higher-priority ignore rules can negate info/exclude. Verify Git's
		// actual result before committing local data, without touching the index.
		try { await execFileAsync("git", ["check-ignore", "--no-index", "--quiet", "--", relative], gitOptions); }
		catch (error) { signal?.throwIfAborted(); throw new Error(`${config}: Git local-config exclusion could not be established; local config left unchanged`, { cause: error }); }
		signal?.throwIfAborted();
	});
}

function adapterResult(options: RunEngineOptions, root: string, data: unknown, error?: string): OperationResult {
	return { ok: !error, status: error ? "error" : "success", exitCode: null, signal: null, findings: false, stdout: JSON.stringify(data), stderr: error ?? "", stdoutTruncated: false, stderrTruncated: false, binary: "", cwd: root, argv: options.argv, trustedOverride: false, message: error, integration: { adapter: "pi", engineRun: false, operation: options.argv[0] ?? "", root } };
}

async function pin(options: RunEngineOptions, root: string, pi: Pick<ExtensionAPI, "getCommands">, sessionCwd: string, committed: string[]): Promise<OperationResult> {
	const args = options.argv.slice(1);
	const action = args.shift(); const command = args.shift();
	if (!command || !["pin", "unpin"].includes(action ?? "") || args.some((arg) => !["--project", "--user"].includes(arg)) || (args.includes("--project") && args.includes("--user"))) throw new Error("Usage: pin <pin|unpin> <command> [--project|--user]");
	const canonical = command === "teach" ? "init" : command;
	const metadata: unknown = JSON.parse(await readFile(path.join(getSkillDir(), "scripts/command-metadata.json"), { encoding: "utf8", signal: options.signal }));
	options.signal?.throwIfAborted();
	if (!object(metadata) || !Object.hasOwn(metadata, canonical)) throw new Error(`Unknown command: ${command}`);
	if (typeof pi.getCommands !== "function") throw new Error("This Pi version cannot establish command collision safety; pinning is unavailable. Use /design-*.");
	// Pi loads project prompts directly under the session cwd, independently of
	// the engine's app/root or --target resolution and per-call cwd overrides.
	const file = path.join(args.includes("--user") ? getAgentDir() : path.join(sessionCwd, ".pi"), "prompts", `${command}.md`);
	return withManagedFileMutation(file, options.signal, async () => {
		const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
		options.signal?.throwIfAborted();
		if (info && !info.isFile()) throw new Error(`${file}: not a regular owned prompt; left unchanged`);
		const existing = await optionalText(file, options.signal);
		const owned = existing?.includes(PIN_MARKER) === true;
		if (existing !== undefined && !owned) throw new Error(`${file}: non-owned prompt; left unchanged`);
		if (action === "unpin") {
			options.signal?.throwIfAborted();
			if (owned) { await rm(file); committed.push(file); }
			options.signal?.throwIfAborted();
			return adapterResult(options, root, { file, removed: owned, reloadRequired: owned, committed });
		}
		let collision;
		for (const candidate of pi.getCommands().filter((candidate) => candidate.name === command)) {
			// Pi discovery keeps lexical source paths, including project aliases.
			// Only a known existing prompt at this owned physical destination is ours.
			if (owned && candidate.source === "prompt" && candidate.sourceInfo?.path) {
				const identity = await realpath(candidate.sourceInfo.path).catch(() => undefined);
				options.signal?.throwIfAborted();
				if (identity !== undefined && identity === await realpath(file)) continue;
			}
			collision = candidate;
			break;
		}
		if (collision) throw new Error(`/${command} already belongs to ${collision.source}; use /design-${canonical}`);
		const template = await readFile(path.join(getSkillDir(), "../../prompts", `design-${canonical}.md`), { encoding: "utf8", signal: options.signal });
		options.signal?.throwIfAborted();
		const content = template.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/, `$1\n${PIN_MARKER}\n`);
		await atomicWrite(file, content, options.signal, () => committed.push(file));
		return adapterResult(options, root, { file, command, canonical: `design-${canonical}`, reloadRequired: true, committed, message: "Run /reload to discover this native prompt shortcut." });
	});
}

export function registerCompatibility(pi: ExtensionAPI): void {
	if (typeof pi.on !== "function") return;
	pi.on("input", (event) => {
		if (!/^\/i(?:\s|$)/.test(event.text) || typeof pi.getCommands !== "function") return;
		const commands = pi.getCommands();
		if (commands.some((command) => command.name === "i") || !commands.some((command) => command.name === "impeccable" && command.source === "prompt")) return;
		return { action: "transform", text: event.text.replace(/^\/i(?=\s|$)/, "/impeccable") };
	});
}

/** Every mutating entry uses this context before config IO or upstream dispatch. */
async function validatedContext(cwd: string, argv: readonly string[], signal?: AbortSignal) {
	signal?.throwIfAborted();
	const { target, withoutTarget } = parseTargetArgs(argv);
	const root = await resolveProject(cwd, target);
	signal?.throwIfAborted();
	return { root, target, withoutTarget };
}

async function reportMetadata(root: string) {
	try { return await hookStatus(root); }
	catch (error) { return { available: false, error: String(error), root }; }
}

/** Pi management boundary. runEngine remains a raw, bounded managed executor. */
export async function runOperation(options: RunEngineOptions, pi: Pick<ExtensionAPI, "getCommands">, sessionCwd = options.cwd ?? process.cwd()): Promise<OperationResult> {
	if (["live", "live-generate", "live-poll", "live-server", "live-complete"].includes(options.argv[0] ?? "")) {
		const action = options.argv[0] === "live" ? "start" : options.argv[0] === "live-generate" ? "generate" : options.argv[0] === "live-complete" ? "reply" : "status";
		return adapterResult(options, options.cwd ?? sessionCwd, { handoff: "impeccable_live", action, argv: options.argv.slice(1) }, `Use impeccable_live ${action}; the Pi session owner exclusively manages native boot, polling, acknowledgements and helper cleanup. Do not launch a competing poller or shell helper.`);
	}
	if (!["hooks", "hook-admin", "pin", "unpin", "ignores", "doctor", "context", "update", "install", "link", "skills"].includes(options.argv[0] ?? "")) return runEngine(options);
	return serialized("pi-impeccable-management", () => runOperationUnqueued(options, pi, path.resolve(sessionCwd)));
}

async function runOperationUnqueued(options: RunEngineOptions, pi: Pick<ExtensionAPI, "getCommands">, sessionCwd: string): Promise<OperationResult> {
	let cwd = options.cwd ?? sessionCwd;
	const argv = [...options.argv];
	if (argv[0] === "hook-admin") argv[0] = "hooks";
	if (argv[0] === "unpin") argv.splice(0, 1, "pin", "unpin");
	if (argv[0] === "pin" && !["pin", "unpin"].includes(argv[1] ?? "")) argv.splice(1, 0, "pin");
	if (argv[0] === "hooks" && argv[1]) argv[1] = argv[1].toLowerCase();
	const verb = argv[0];
	if (!["hooks", "pin", "ignores", "doctor", "context", "update", "install", "link", "skills"].includes(verb ?? "")) return runEngine(options);
	let root = path.resolve(cwd);
	const committed: string[] = [];
	let engineResult: EngineRunResult | undefined;
	try {
		options.signal?.throwIfAborted();
		cwd = await resolveDirectory(cwd);
		sessionCwd = await resolveDirectory(sessionCwd);
		options.signal?.throwIfAborted();
		if (verb === "context" || verb === "doctor" && !argv.includes("--fix")) {
			// Genuine read-only reports retain upstream target/error semantics.
			const result = await runEngine({ ...options, argv, cwd });
			let hooks: unknown;
			try { root = (await validatedContext(cwd, argv)).root; hooks = await reportMetadata(root); }
			catch (error) { hooks = { available: false, error: String(error), root }; }
			return { ...result, integration: { adapter: "pi", engineRun: true, operation: verb, root, hooks, upstreamManifestDiscovery: "Upstream cannot discover this external Pi package; its genuine artifact findings remain in stdout." } };
		}
		const context = await validatedContext(cwd, argv, options.signal);
		root = context.root;
		const { target, withoutTarget } = context;
		if (["hooks", "pin", "ignores"].includes(verb ?? "")) argv.splice(0, argv.length, ...withoutTarget);
		// Upstream may interpret missing dotted selectors as their parent. Never
		// give a mutating doctor the original selector after validating its scope.
		// Absence selects workspace reporting upstream; never synthesize a target.
		if (verb === "doctor" && target !== undefined) argv.splice(0, argv.length, ...withoutTarget, "--target", root);
		const managed = { ...options, argv, cwd: root };
		if (verb === "doctor") return await serialized(root, async () => {
			options.signal?.throwIfAborted();
			const result = await runEngine(managed);
			// Return the actual engine outcome even after cancellation: upstream
			// artifact mutations are not tracked by the adapter's commit list.
			return { ...result, integration: { adapter: "pi", engineRun: true, operation: verb, root, ...(target === undefined ? {} : { originalTarget: target, effectiveTarget: root }), hooks: await reportMetadata(root), upstreamManifestDiscovery: "Upstream cannot discover this external Pi package; its genuine artifact findings remain in stdout." } };
		});
		if (["update", "install", "link"].includes(verb ?? "") || (verb === "skills" && ["update", "install", "link"].includes(argv[1] ?? ""))) return adapterResult(options, root, { managedBy: "repository", message: "Upgrade or change this vendored distribution through this repository's README vendoring procedure." });
		if (verb === "pin") {
			const result = await pin(managed, root, pi, sessionCwd, committed);
			options.signal?.throwIfAborted();
			result.integration!.committed = committed;
			return result;
		}
		const operationResult = await serialized<OperationResult>(root, async () => {
			options.signal?.throwIfAborted();
			if (verb === "hooks") {
				const action = argv[1] ?? "status";
				if (["on", "off", "status", "reset"].includes(action)) {
					if (argv.length > 2) throw new Error(`Unexpected arguments to hooks ${action}`);
					const configs = await readConfigs(root, options.signal);
					options.signal?.throwIfAborted();
					if (action !== "status" && (action === "on" || configs[1]!.text !== undefined)) await excludeLocalConfig(root, options.signal, committed);
					if (action !== "status") for (const [index, config] of configs.entries()) {
						const hook = { ...(config.value.hook as Record<string, unknown> | undefined) };
						if (action === "reset") {
							for (const key of ["enabled", "consent", "quiet", "auditLog", "perEditRules", "limits", "ignoreRules", "ignoreFiles", "ignoreValues"]) delete hook[key];
							// Explicit off masks legacy hook defaults and other retained settings.
							if (index === 0) hook.enabled = false;
						} else if (index === 0 || Object.hasOwn(hook, "enabled")) hook.enabled = action === "on";
						if (action === "on" && index === 1) hook.consent = "accepted";
						let detector = config.value.detector;
						if (action === "reset" && object(detector)) {
							detector = { ...detector };
							for (const key of ["ignoreRules", "ignoreFiles", "ignoreValues"]) delete (detector as Record<string, unknown>)[key];
						}
						if (config.text !== undefined || Object.keys(hook).length) await saveConfig(config, { ...config.value, ...(detector === undefined ? {} : { detector }), hook }, options.signal, committed);
					}
					const status = await hookStatus(root, options.signal);
					options.signal?.throwIfAborted();
					const result = adapterResult(options, root, status);
					result.integration!.committed = committed;
					return result;
				}
			}
			const isIgnore = verb === "ignores" || (verb === "hooks" && argv[1]?.startsWith("ignore-"));
			if (isIgnore) {
				// The upstream admin validates isolated copies across a deliberate Git
				// boundary. No staging artifacts are visible to Git in the real project.
				const configs = await readConfigs(root, options.signal);
				options.signal?.throwIfAborted();
				if (verb === "ignores" && ["", "list", "ls", "status", "--help", "-h"].includes((argv[1] ?? "").toLowerCase())) {
					const result = await runEngine(managed);
					return { ...result, integration: { adapter: "pi", engineRun: true, operation: verb, root, configPaths: configs.map((config) => config.file) } };
				}
				const stage = await mkdtemp(path.join(os.tmpdir(), "pi-impeccable-admin-"));
				try {
					options.signal?.throwIfAborted();
					await mkdir(path.join(stage, ".impeccable"));
					options.signal?.throwIfAborted();
					await mkdir(path.join(stage, ".git"));
					options.signal?.throwIfAborted();
					for (const config of configs) if (config.text !== undefined) {
						await writeFile(path.join(stage, ".impeccable", path.basename(config.file)), config.text, { signal: options.signal });
						options.signal?.throwIfAborted();
					}
					const result = await runEngine({ ...managed, cwd: stage });
					engineResult = result;
					options.signal?.throwIfAborted();
					if (result.ok) {
						const next = await readConfigs(stage, options.signal);
						options.signal?.throwIfAborted();
						if (next[1]!.text !== undefined) await excludeLocalConfig(root, options.signal, committed);
						for (const [index, config] of configs.entries()) {
							options.signal?.throwIfAborted();
							if (JSON.stringify(config.value) !== JSON.stringify(next[index]!.value)) await saveConfig(config, next[index]!.value, options.signal, committed);
						}
					}
					options.signal?.throwIfAborted();
					return { ...result, integration: { adapter: "pi", engineRun: true, operation: verb ?? "", root, configPaths: configs.map((config) => config.file), validationCwd: stage, committed } };
				} finally { await rm(stage, { recursive: true, force: true }); }
			}
			if (verb === "hooks") throw new Error(`Unknown hook action: ${argv[1]}`);
			const result = await runEngine({ ...options, argv, cwd });
			return { ...result, integration: { adapter: "pi", engineRun: true, operation: verb ?? "", root } };
		});
		options.signal?.throwIfAborted();
		return operationResult;
	} catch (error) {
		const cancelled = options.signal?.aborted;
		const message = `${cancelled ? "Operation cancelled" : String(error)}${committed.length ? `; committed paths: ${committed.join(", ")}; remaining changes were not committed` : "; no managed files committed"}`;
		const result = adapterResult(options, root, { committed, partial: committed.length > 0 }, message);
		return { ...result, ...(engineResult ? { stdout: engineResult.stdout, binary: engineResult.binary, exitCode: engineResult.exitCode } : {}), status: cancelled ? "cancelled" : "error", integration: { ...result.integration!, engineRun: engineResult !== undefined, committed, partial: committed.length > 0 } };
	}
}
