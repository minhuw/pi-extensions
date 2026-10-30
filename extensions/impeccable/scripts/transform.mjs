#!/usr/bin/env node
/**
 * Deterministic Pi transformation for the vendored Impeccable skill distribution.
 *
 * Reads the pristine vendor snapshot recorded in `vendor/impeccable-4.8.0` and writes
 * the Pi-adapted skill under `skills/impeccable` and the native prompt templates under
 * `prompts`. The transformation is pure and recorded in LOCAL-PATCHES.md; running it
 * against the committed snapshot reproduces the committed `skills/` and `prompts/`
 * trees byte-for-byte.
 *
 * Usage:
 *   node scripts/transform.mjs [--vendor <dir>] [--out <dir>]
 *
 *   --vendor  Directory containing the pristine snapshot (defaults to the committed one).
 *   --out     Directory to write `skills/` and `prompts/` into (defaults to this extension).
 */
import { PI_RUNTIME, PI_LIVE } from "./pi-runtime.mjs";
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const vendorRoot = path.resolve(args.vendor ?? path.join(extensionRoot, "vendor", "impeccable-4.8.0"));
const outRoot = path.resolve(args.out ?? extensionRoot);

/**
 * Path localization: upstream's generated Pi distribution addresses the launcher as the
 * project-relative `.pi/skills/impeccable/scripts` directory. Pi advertises a skill's
 * SKILL.md location and resolves relative references against the skill directory, so the
 * portable address is `<skill-base-dir>/scripts`. See LOCAL-PATCHES.md.
 */
const UPSTREAM_SCRIPTS_DIR = ".pi/skills/impeccable/scripts";
const LOCAL_SCRIPTS_DIR = "<skill-base-dir>/scripts";

/**
 * Upstream's Setup step describes a two-level plugin layout (".pi/skills", with a plugin
 * root above the skill folder) and always invokes the launcher directly. This integration
 * installs the skill directly, so the step is replaced with a portable formulation that
 * prefers the managed `impeccable_run` tool and documents the absolute skill launcher as
 * the fallback. Recorded in LOCAL-PATCHES.md.
 */
const SETUP_STEP1_ORIGINAL =
	"1. Run `<skill-base-dir>/scripts/impeccable context` once per session, where `<skill-base-dir>` is the directory that contains this SKILL.md (the skill folder, not a plugin root two levels above it); keep cwd at the user's project. That base directory resolves every `.pi/skills/impeccable/scripts/impeccable <verb>` command in this skill and its references, and `.pi/skills/impeccable/scripts` is the fallback only when the runtime reports no base directory. On a Windows shell without `sh`, call `.pi/skills/impeccable/scripts/impeccable.cmd` instead. The launcher runs a self-contained binary that ships next to it or is downloaded once on first run; no Node or other runtime is required. Pass a named source file or route as `--target <path>`. It loads PRODUCT.md, DESIGN.md, the matching surface brief, and native-platform guidance when applicable; follow its directives and do not rerun it.";
const SETUP_STEP1_LOCAL =
	`1. Run the Impeccable engine's \`context\` command once per session, where \`<skill-base-dir>\` is the directory that contains this SKILL.md (the skill folder); keep cwd at the user's project. Prefer the \`impeccable_run\` tool when it is available: call it with \`argv: ["context"]\`, and pass \`cwd\` or \`timeoutMs\` only when the project directory differs from the session cwd or a run may need more time. When \`impeccable_run\` is not available, resolve the absolute skill launcher \`<skill-base-dir>/scripts/impeccable\` from the \`<location>\` Pi advertises for this skill and run \`<skill-base-dir>/scripts/impeccable context\` instead; on a Windows shell without \`sh\`, run \`<skill-base-dir>/scripts/impeccable.cmd context\`. The engine is a self-contained binary that ships next to the launcher or is downloaded once on first run and verified against the skill's checksums; no Node or other runtime is required. Pass a named source file or route as \`--target <path>\`. It loads PRODUCT.md, DESIGN.md, the matching surface brief, and native-platform guidance when applicable; follow its directives and do not rerun it.`;

const ADAPTED_REFERENCES = new Set(["critique.md", "new-work.md", "visualize.md", "document.md", "live.md", "generate.md", "live-setup.md", "component-review.md"]);
const PI_LINK = "Pi: read [pi-runtime.md](pi-runtime.md) for native questions, complete Agent role packets, capability checks, and explicit fallback reporting before executing this playbook.\n\n";

function replaceRequired(text, original, replacement) {
	if (!text.includes(original)) throw new Error(`Missing upstream adaptation anchor: ${original.slice(0, 100)}`);
	return text.replace(original, replacement);
}

/** Localize paths and adapt interaction without removing source operations. */
function localizeSkill(text, relative) {
	let localized = text
		.replace(SETUP_STEP1_ORIGINAL, SETUP_STEP1_LOCAL)
		.replaceAll(UPSTREAM_SCRIPTS_DIR, LOCAL_SCRIPTS_DIR);
	if (relative === "SKILL.md") {
		localized = replaceRequired(localized, "**Pin / Unpin:** `<skill-base-dir>/scripts/impeccable pin <pin|unpin> <command>` creates or removes a standalone `/<command>` shortcut. Report the script's result concisely; relay stderr verbatim on error.", "**Pin / Unpin:** Use impeccable_run with argv: [\"pin\", \"pin\", \"<command>\"] or [\"pin\", \"unpin\", \"<command>\"], optionally --project (default) or --user. The Pi adapter creates native prompt shortcuts with ownership markers in the session cwd's .pi/prompts (project) or the agent prompts directory (user), independently of engine cwd/target/root selection, and checks current commands through Pi discovery; it refuses conflicts such as Writer /polish. Run /reload after a change. Unpin removes only adapter-owned prompts. All /design-* templates remain canonical; never modify package resources or create harness-local skills.");
		localized = replaceRequired(localized, "## Setup\n", "## Setup\n\nRead [reference/pi-runtime.md](reference/pi-runtime.md) for impeccable_question, impeccable_delegate, impeccable_live and impeccable_capabilities; these adapters apply to every playbook and emitted engine directive.\n");
	}
	if (relative === "hooks.md") {
		localized = `## Pi controls and delivery\n\nUse impeccable_run with argv: ["hooks", "<action>", ...args] for this playbook. Pi automatic scanning is OFF until explicit hook.enabled:true (or /impeccable hooks on). Shared/local config precedence, consent overrides and legacy environment flags apply. on/off/status/reset manage this extension only: no foreign manifests or harness-local skill installs. reset disables Pi scanning and clears hook runtime controls and detector ignores while retaining unrelated product/visual settings. Ignore actions and direct ignores CRUD use upstream validation on isolated temporary config copies, then commit changed values atomically; malformed JSON is reported without overwriting it. Management cwd/session cwd must be existing accessible directories; directory aliases resolve to their physical identity. Target forms --target X, --target=X and -t X accept existing paths or a unique workspace basename, including dotted names; excluded/missing/ambiguous bare selectors fail before management writes regardless of extension. New source-file targets require an existing explicit parent and the same project boundary; otherwise use an existing app/parent path. Local config commits require canonical Git containment and a verified exclusion; escaping destinations and already tracked local configs are refused without changing the index. Cancellation or conflict reports actual committed paths in integration.committed and marks partial changes; inspect those paths before retrying. Peers without Pi's public shared mutation queue refuse management writes. Disposable detector and validation state stays outside the project and is cleaned by its owner.\n\nSuccessful native and nested edit/write calls provide affected paths and bounded pre-edit evidence. The real upstream hook receives a supported PostToolUse envelope for immediate-tier feedback and one completion Stop deep pass over touched files. Feedback is bounded, deduplicated and delivered through Pi boundary entries; structured tool results stay intact. Up to 24 scans, 20 primary files per project, four projects and one corrective continuation per user invocation. Abort, queued input and shutdown stop further feedback. Native ios/android/adaptive is inapplicable, never clean. Temporary upstream live-preview markers suppress feedback; the Pi live owner handles native delivery independently. On older Pi versions without actionable boundary events, automatic continuation/deep-pass delivery is unavailable; run manual detect and report that limitation.\n\nThe following upstream cross-harness details document engine behavior; Pi uses the adapter rules above. Commands shown as launcher calls must go through impeccable_run for management.\n\n` + localized;
		localized = replaceRequired(localized, "Set `enabled: true` in `.impeccable/config.json`, record local hook consent as accepted, and install/repair provider hook manifests when the skill is installed.", "Enable this Pi extension in project config and record local consent; do not install provider manifests.");
		localized = replaceRequired(localized, "Delete the project config, dedup cache, and Cursor pending queue, and remove the hook's entries from every provider manifest `on` installs, the committed Copilot file included (a team-shared `settings.json` that `on` never writes is never touched).", "Disable Pi scanning, reset hook runtime controls and detector ignores, and retain other Impeccable settings and every foreign manifest.");
	}
	if (relative === "doctor.md") {
		localized = `## Pi artifact report\n\nRun this playbook through impeccable_run, preserving requested doctor flags (including --json, --fix and --target). Before doctor --fix dispatch, Pi strictly validates the management selector and uses the canonical selected project as cwd. Only an explicitly supplied target is replaced by canonical --target, with integration.originalTarget and integration.effectiveTarget recording that selection; targetless calls retain target absence and omit both fields so upstream workspace rows/findings remain available. Read-only doctor/context retain upstream flags and error/report behavior even if Pi metadata cannot resolve the selector. stdout is the genuine upstream report, including actual findings and ruleRegistryAvailable; Pi enablement/status is separate integration metadata. Upstream manifest discovery cannot see this external Pi package: do not infer Pi hook availability from its manifest report, hide real findings, or call an unavailable/truncated report clean. Repository vendoring owns distribution upgrades; runtime update/install/link does not overwrite this package.\n\n` + localized;
		localized = replaceRequired(localized, "and `npx impeccable update` fixes it, or the harness's plugin manager for a plugin install", "and this repository's vendoring procedure updates the pinned distribution");
	}
	if (ADAPTED_REFERENCES.has(relative)) localized = PI_LINK + localized;
	if (["live.md", "generate.md", "live-setup.md"].includes(relative)) localized = PI_LIVE + "\nThe complete upstream playbook follows. Apply the Pi transport mapping above to its native command examples.\n\n" + localized;
	if (relative === "new-work.md") {
		localized = replaceRequired(localized, "and with no answer there either, proceed unattended with the assigned direction and state the assumptions.", "and with no answer there either, ask in chat and wait; do not record an assumed choice or approval.");
		localized = replaceRequired(localized, "Never read the shipped agents' definition files before spawning; the harness loads them at spawn, and you owe only the input packet.", "Use impeccable_delegate to load the complete adapted role definition and supply the input packet; on main-session Agent handoff, include that entire role text. Pi does not install canonical roles as global agent types.");
	}
	if (relative === "visualize.md") {
		localized = replaceRequired(localized, "only after both fail may you treat the choice as delegated, and a delegated pick is recorded exactly as an approval is and disclosed in your first reply, not your last.", "after both fail, present the options and visual blocker in chat and wait for an actual answer. Only explicit user words delegating the choice authorize a delegated pick; record those words and disclose the scope before proceeding.");
		localized = replaceRequired(localized, "A structured simulated user counts as attended and receives the same question.", "An actual user response through the structured question tool counts as attended; never simulate an answer.");
	}
	if (relative === "critique.md") localized = replaceRequired(localized, '"Unavailable" means exactly one thing: no sub-agent/Task tool is exposed in this session (or, on harnesses that ask, the user declined). It does not mean inconvenient.', 'On Pi, unavailable includes a missing/non-callable Agent API or a configured agent type that cannot dispatch. Automatic sequential degraded fallback requires confirmed no-child dispatch; a wrapped-up/partial child requires inspection of actual output and artifacts and a bounded handoff for remaining work, never full inline replay. Active or unresolved children require management before dependent work. Report the actual limitation. It does not mean inconvenient. Fresh context means inherit_context:false, not isolated:true (which strips extension tools).');
	return localized;
}

/**
 * Localize a canonical agent definition. Upstream's source template uses `{{scripts_path}}`
 * and `{{reference_path}}` placeholders that the Pi generator resolves at build time; this
 * integration resolves them against the installed skill directory. Recorded in
 * LOCAL-PATCHES.md.
 */
function localizeAgent(text) {
	// Compile the provider branch out for Pi; retain all generic role instructions.
	return text
		.replace(/<codex>[\s\S]*?<\/codex>\n?/g, "")
		.replaceAll("{{scripts_path}}", "<skill-base-dir>/scripts")
		.replaceAll("{{reference_path}}", "<skill-base-dir>/reference");
}

/** Freeform `/impeccable` (and `/design` alias) body: freeform requests plus upstream subcommands. */
function freeformTemplate(description) {
	return [
		"---",
		`description: ${JSON.stringify(description)}`,
		'argument-hint: "[request, subcommand, or target]"',
		"---",
		"Use the Impeccable design skill for this request. These instructions apply only to this invocation, not as permanent session rules.",
		"",
		"1. Locate the Impeccable skill in your available skills: its `<name>` is `impeccable` and its `<location>` is the path of `SKILL.md`. The skill directory — the parent of `<location>` — is `<skill-base-dir>`.",
		"2. Read `<skill-base-dir>/SKILL.md` and follow its Setup and Routing sections for the request below. Run the Impeccable engine once per session as its Setup directs (prefer the `impeccable_run` tool; Setup documents the absolute launcher fallback), and follow the directives it prints.",
		"3. Route the request:",
		"   - `pin` or `unpin`: follow the Pin/Unpin section of `<skill-base-dir>/SKILL.md` and run the command it names.",
		"   - `i`: compatibility alias of the Impeccable skill; route its remaining request normally. `craft` remains the upstream craft playbook.",
		"   - `teach`: this is an alias of `init`; read `<skill-base-dir>/reference/init.md` and follow it end-to-end.",
		"   - `doctor`: read `<skill-base-dir>/reference/doctor.md` and follow it end-to-end.",
		"   - `live` or `generate`: use impeccable_live start/generate and the complete native playbook; route every poll/reply/complete/stop instruction through the session owner.",
		"   - `hooks`: read `<skill-base-dir>/reference/hooks.md` and follow it end-to-end.",
		"   - Any command in the skill's Commands table: read the matching reference under `<skill-base-dir>/reference/` and follow it end-to-end (use the `.native.md` variant on iOS or Android targets).",
		"   - With no argument: read `<skill-base-dir>/reference/routing.md` and present its context-aware menu; never auto-run a command.",
		"   - For a new surface or replacement visual world, follow `<skill-base-dir>/reference/new-work.md`.",
		"4. Read `<skill-base-dir>/reference/pi-runtime.md` for impeccable_question, impeccable_delegate and capability guidance; retain visual decision pages and wait for actual answers.",
		"5. Read `<skill-base-dir>/reference/craft-floor.md` immediately before any UI edit.",
		"",
		"Request:",
		"$ARGUMENTS",
		"",
	].join("\n");
}

/** Per-command `/design-<command>` body: route to the command's complete reference playbook. */
function commandTemplate(command, metadata) {
	const nativeLine =
		command === "adapt" || command === "audit"
			? ` On an iOS or Android target, read and follow \`<skill-base-dir>/reference/${command}.native.md\` as the playbook.`
			: "";
	return [
		"---",
		`description: ${JSON.stringify(metadata.description)}`,
		...(metadata.argumentHint ? [`argument-hint: ${JSON.stringify(metadata.argumentHint)}`] : []),
		"---",
		"Use the Impeccable design skill for this request. These instructions apply only to this invocation, not as permanent session rules.",
		"",
		"1. Locate the Impeccable skill in your available skills: its `<name>` is `impeccable` and its `<location>` is the path of `SKILL.md`. The skill directory — the parent of `<location>` — is `<skill-base-dir>`.",
		"2. Read `<skill-base-dir>/SKILL.md` and follow its Setup section, including running the Impeccable engine once per session as it directs (prefer the `impeccable_run` tool; Setup documents the absolute launcher fallback) and following the directives it prints.",
		`3. Follow the \`${command}\` playbook end-to-end: read \`<skill-base-dir>/reference/${command}.md\` and comply with it completely, including its verification and handoff steps. Do not reduce the playbook to a shortcut.${nativeLine}`,
		"4. Read `<skill-base-dir>/reference/pi-runtime.md` for impeccable_question, impeccable_delegate and capability guidance; retain visual decision pages and wait for actual answers.",
		"5. Read `<skill-base-dir>/reference/craft-floor.md` immediately before any UI edit.",
		"",
		...(["live", "generate"].includes(command) ? ["Use impeccable_live start/generate/status/reply/resume/stop; all native poll, reply, complete and helper lifetime instructions route through the session owner. Retain the full upstream browser and source workflow."] : []),
		`${command} request:`,
		"$ARGUMENTS",
		"",
	].join("\n");
}

async function main() {
	const piDist = path.join(vendorRoot, "pi-dist");
	const skillOut = path.join(outRoot, "skills", "impeccable");

	// Validate the snapshot carries the expected marker files.
	await readFile(path.join(piDist, "SKILL.md"), "utf8");
	await readFile(path.join(piDist, "scripts", "command-metadata.json"), "utf8");

	// 1. SKILL.md — localized.
	const skillMarkdown = await readFile(path.join(piDist, "SKILL.md"), "utf8");
	await mkdir(skillOut, { recursive: true });
	await writeFile(path.join(skillOut, "SKILL.md"), localizeSkill(skillMarkdown, "SKILL.md"));

	// 2. Reference playbooks — localized, preserving every file including degraded/.
	const referenceIn = path.join(piDist, "reference");
	for (const relative of await walk(referenceIn)) {
		const target = path.join(skillOut, "reference", relative);
		await mkdir(path.dirname(target), { recursive: true });
		const content = await readFile(path.join(referenceIn, relative), "utf8");
		await writeFile(target, localizeSkill(content, relative));
	}

	await writeFile(path.join(skillOut, "reference", "pi-runtime.md"), PI_RUNTIME);

	// 3. Supporting scripts retain upstream content; the two fallback launchers
	//    explicitly identify this external package as Pi. Preserve executable mode.
	const scriptsIn = path.join(piDist, "scripts");
	for (const relative of await walk(scriptsIn)) {
		const target = path.join(skillOut, "scripts", relative);
		await mkdir(path.dirname(target), { recursive: true });
		await copyFile(path.join(scriptsIn, relative), target);
		if (relative === "impeccable") {
			const launcher = await readFile(target, "utf8");
			await writeFile(target, replaceRequired(launcher, "export IMPECCABLE_SKILL_DIR IMPECCABLE_SELF", "IMPECCABLE_PROVIDER_ID=pi\nexport IMPECCABLE_SKILL_DIR IMPECCABLE_SELF IMPECCABLE_PROVIDER_ID"));
		}
		if (relative === "impeccable.cmd") {
			const launcher = await readFile(target, "utf8");
			await writeFile(target, replaceRequired(launcher, 'if not defined IMPECCABLE_SELF set "IMPECCABLE_SELF=%~f0"', 'if not defined IMPECCABLE_SELF set "IMPECCABLE_SELF=%~f0"\r\nset "IMPECCABLE_PROVIDER_ID=pi"'));
		}
		if (process.platform !== "win32" && relative === "impeccable") await chmod(target, 0o755);
	}

	// 4. Canonical agent-role definitions — localized into the skill so they stay reachable.
	//    Upstream's Pi generator only emits the degraded inline fallbacks; see LOCAL-PATCHES.md.
	const agentsIn = path.join(vendorRoot, "source", "agents");
	for (const relative of await walk(agentsIn)) {
		const target = path.join(skillOut, "reference", "agents", relative);
		await mkdir(path.dirname(target), { recursive: true });
		const content = await readFile(path.join(agentsIn, relative), "utf8");
		await writeFile(target, localizeAgent(content));
	}

	// 5. Prompt templates: /impeccable, /design alias, and one /design-<command> per
	//    upstream command-metadata entry.
	const promptsOut = path.join(outRoot, "prompts");
	await mkdir(promptsOut, { recursive: true });
	await writeFile(
		path.join(promptsOut, "impeccable.md"),
		freeformTemplate(
			"Design, redesign, critique, audit, or improve a frontend interface with the Impeccable design skill, or run an upstream Impeccable subcommand",
		),
	);
	await writeFile(
		path.join(promptsOut, "design.md"),
		freeformTemplate("Design a frontend interface with the Impeccable design skill (freeform alias of /impeccable)"),
	);

	const metadata = JSON.parse(
		await readFile(path.join(piDist, "scripts", "command-metadata.json"), "utf8"),
	);
	for (const [command, definition] of Object.entries(metadata)) {
		await writeFile(
			path.join(promptsOut, `design-${command}.md`),
			commandTemplate(command, definition),
		);
	}
}

async function walk(root) {
	const files = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) {
			for (const child of await walk(full)) files.push(path.join(entry.name, child));
		} else {
			files.push(entry.name);
		}
	}
	return files.sort();
}

function parseArgs(argv) {
	const parsed = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--vendor") parsed.vendor = argv[++i];
		else if (argv[i] === "--out") parsed.out = argv[++i];
		else throw new Error(`unknown argument: ${argv[i]}`);
	}
	return parsed;
}

await main();
