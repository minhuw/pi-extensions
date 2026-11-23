import * as fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import agentDesktopExtension, {
	AGENT_DESKTOP_SHARED_KEY,
	AGENT_DESKTOP_STATUS_KEY,
	CHILD_SESSION_HOOKS,
	deriveDesktopSessionId,
	formatDesktopStatus,
	INSTALL_HINT,
	MAX_RESULT_LINES,
	META_SUBCOMMANDS,
	parseAgentDesktopArgv,
	PHYSICAL_SUBCOMMANDS,
	resolveBundledAgentDesktop,
	runAgentDesktop,
	type ChildSessionHook,
} from "../index.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const skillsRoot = path.join(repoRoot, "extensions/agent-desktop/skills");
const skillDir = path.join(skillsRoot, "agent-desktop");

// Minimal valid 1x1 transparent PNG
const ONE_BY_ONE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface RecordedInvocation {
	argv: string[];
	cwd: string;
	session: string | undefined;
	stdin: string;
}

let sandboxRoot: string;
let projectCwd: string;
let agentDir: string;
let sessionDir: string;
let fakeBinPath: string;
let logFilePath: string;
let prevAgentDir: string | undefined;
let prevDesktopBin: string | undefined;
let prevDesktopSession: string | undefined;

async function createFakeAgentDesktopBinary(binPath: string, logPath: string): Promise<void> {
	const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const argv = process.argv.slice(2);
const logFile = ${JSON.stringify(logPath)};

if (argv.includes("hang")) {
	fs.appendFileSync(
		logFile,
		JSON.stringify({
			argv,
			cwd: process.cwd(),
			session: process.env.AGENT_DESKTOP_SESSION,
			stdin: "",
		}) + "\\n",
		"utf8",
	);
	setTimeout(() => process.exit(0), 60000);
	return;
}

(async () => {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const stdin = Buffer.concat(chunks).toString("utf8");

	const record = {
		argv,
		cwd: process.cwd(),
		session: process.env.AGENT_DESKTOP_SESSION,
		stdin,
	};
	fs.appendFileSync(logFile, JSON.stringify(record) + "\\n", "utf8");

	const globalValueFlags = new Set([
		"--session",
		"-s",
		"--agent-id",
		"--wait-for",
		"-w",
		"--wait-timeout",
		"--screenshot",
	]);
	const screenshotValueFlags = new Set([
		"--app",
		"--window-id",
		"--screen",
		"--format",
		"--quality",
		"-q",
		"--region",
		"--output",
		"-o",
	]);
	const sessionValueFlags = new Set(["--app", "--window-id", "--name"]);

	let explicitSession;
	let subcommand;
	let subIdx = -1;
	let endOfFlags = false;
	let isHelp = false;

	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (!endOfFlags) {
			if (tok === "--") {
				endOfFlags = true;
				continue;
			}
			if (tok === "--session" || tok === "-s") {
				explicitSession = argv[i + 1];
				i++;
				continue;
			}
			if (tok.startsWith("--session=")) {
				explicitSession = tok.slice("--session=".length);
				continue;
			}
			if (tok.startsWith("-s=")) {
				explicitSession = tok.slice("-s=".length);
				continue;
			}
			if (globalValueFlags.has(tok)) {
				i++;
				continue;
			}
			if (subcommand === "screenshot" && screenshotValueFlags.has(tok)) {
				i++;
				continue;
			}
			if (tok === "--help" || tok === "-h") {
				isHelp = true;
				continue;
			}
			if (subcommand === undefined && (tok === "--version" || tok === "-V")) {
				subcommand = tok;
				subIdx = i;
				continue;
			}
			if (tok.startsWith("-")) {
				continue;
			}
		}
		if (subcommand === undefined) {
			subcommand = tok;
			subIdx = i;
		}
	}

	if (isHelp) {
		process.stdout.write("Usage: agent-desktop " + (subcommand || "<command>") + " [options]\\n");
		process.exit(0);
	} else if (subcommand === "flood") {
		for (let i = 0; i < 2500; i++) {
			process.stdout.write("line-" + i + "-payload\\n");
		}
		process.exit(0);
	} else if (subcommand === "hold-stdio") {
		const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], {
			detached: true,
			stdio: ["ignore", 1, 2],
		});
		sleeper.unref();
		process.stdout.write(
			JSON.stringify({
				version: "2.6",
				ok: true,
				command: "hold-stdio",
				data: { pid: sleeper.pid },
			}) + "\\n",
		);
		process.exit(0);
	} else if (subcommand === "fail") {
		process.stdout.write(
			JSON.stringify({
				version: "2.6",
				ok: false,
				command: "fail",
				error: { code: "ACTION_FAILED", message: "simulated desktop error" },
			}) + "\\n",
		);
		process.exit(1);
	} else if (subcommand === "status" || subcommand === "doctor") {
		process.stdout.write(
			JSON.stringify({
				version: "2.6",
				ok: true,
				command: subcommand,
				data: {
					adapter: "macos-ax",
					healthy: true,
					permissions: { accessibility: true, screen_recording: true },
					session: process.env.AGENT_DESKTOP_SESSION || null,
				},
			}) + "\\n",
		);
		process.exit(0);
	} else if (subcommand === "permissions") {
		process.stdout.write(
			JSON.stringify({
				version: "2.6",
				ok: true,
				command: "permissions",
				data: {
					accessibility: true,
					screen_recording: true,
					guide: argv.includes("--guide")
						? "System Settings > Privacy & Security > Accessibility"
						: undefined,
				},
			}) + "\\n",
		);
		process.exit(0);
	} else if (subcommand === "skills") {
		process.stdout.write(
			JSON.stringify({
				version: "2.6",
				ok: true,
				command: "skills",
				data: {
					skill: argv[subIdx + 2] || "desktop",
					content: "# agent-desktop core guide\\nsnapshot --app Notes -i -> click @s1:e1 -> screenshot",
				},
			}) + "\\n",
		);
		process.exit(0);
	} else if (subcommand === "session") {
		let sessionAction;
		let sessionPositionalId;
		for (let i = subIdx + 1; i < argv.length; i++) {
			const tok = argv[i];
			if (globalValueFlags.has(tok) || sessionValueFlags.has(tok)) {
				i++;
				continue;
			}
			if (tok.startsWith("-")) continue;
			if (!sessionAction) {
				sessionAction = tok;
			} else if (!sessionPositionalId) {
				sessionPositionalId = tok;
			}
		}
		if (sessionAction === "start") {
			const startedId = process.env.FAKE_SESSION_START_ID || explicitSession || "sess-started-1";
			process.stdout.write(
				JSON.stringify({
					version: "2.6",
					ok: true,
					command: "session start",
					data: { session_id: startedId },
				}) + "\\n",
			);
		} else if (sessionAction === "end") {
			const endedId =
				sessionPositionalId || explicitSession || process.env.AGENT_DESKTOP_SESSION || null;
			process.stdout.write(
				JSON.stringify({
					version: "2.6",
					ok: true,
					command: "session end",
					data: { ended: true, session_id: endedId },
				}) + "\\n",
			);
		} else {
			process.stdout.write(
				JSON.stringify({
					version: "2.6",
					ok: true,
					command: "session",
					data: { sessions: [] },
				}) + "\\n",
			);
		}
		process.exit(0);
	} else if (subcommand === "screenshot") {
		if (argv.includes("ScreenDeniedExit0") || argv.includes("ScreenDeniedExit1")) {
			const exitCode = argv.includes("ScreenDeniedExit0") ? 0 : 1;
			process.stdout.write(
				JSON.stringify({
					version: "2.6",
					ok: false,
					command: "screenshot",
					error: { code: "PERM_DENIED", message: "Screen Recording denied" },
				}) + "\\n",
			);
			process.exit(exitCode);
		}
		let targetPath;
		let shotEndOfFlags = false;
		for (let i = subIdx + 1; i < argv.length; i++) {
			const tok = argv[i];
			if (!shotEndOfFlags) {
				if (tok === "--") {
					shotEndOfFlags = true;
					continue;
				}
				if (tok === "--output" || tok === "-o") {
					targetPath = argv[i + 1];
					i++;
					continue;
				}
				if (tok.startsWith("--output=")) {
					targetPath = tok.slice("--output=".length);
					continue;
				}
				if (globalValueFlags.has(tok) || screenshotValueFlags.has(tok)) {
					i++;
					continue;
				}
				if (tok.startsWith("-")) continue;
			}
			if (targetPath === undefined) {
				targetPath = tok;
			}
		}
		if (targetPath) {
			const resolved = path.resolve(process.cwd(), targetPath);
			fs.mkdirSync(path.dirname(resolved), { recursive: true });
			fs.writeFileSync(resolved, Buffer.from(${JSON.stringify(ONE_BY_ONE_PNG_BASE64)}, "base64"));
			process.stdout.write(
				JSON.stringify({
					version: "2.6",
					ok: true,
					command: "screenshot",
					data: { path: resolved, format: "png", width: 1, height: 1 },
				}) + "\\n",
			);
		} else {
			process.stdout.write(
				JSON.stringify({
					version: "2.6",
					ok: true,
					command: "screenshot",
					data: {
						base64: ${JSON.stringify(ONE_BY_ONE_PNG_BASE64)},
						format: "png",
						width: 1,
						height: 1,
					},
				}) + "\\n",
			);
		}
		process.exit(0);
	} else if (subcommand === "snapshot") {
		process.stdout.write(
			JSON.stringify({
				version: "2.6",
				ok: true,
				command: "snapshot",
				data: {
					snapshot_id: "s1",
					app: "Notes",
					tree: '- window "Notes" [@s1:e1]\\n  - textArea "Body" [@s1:e2]\\n  - button "Save" [@s1:e3]',
				},
			}) + "\\n",
		);
		process.exit(0);
	} else {
		process.stdout.write(
			JSON.stringify({
				version: "2.6",
				ok: true,
				command: subcommand || "unknown",
				data: {
					argv,
					session: process.env.AGENT_DESKTOP_SESSION || null,
					stdinReceived: stdin.length > 0,
				},
			}) + "\\n",
		);
		process.exit(0);
	}
})();
`;
	await writeFile(binPath, script, "utf8");
	await chmod(binPath, 0o755);
}

async function readInvocations(): Promise<RecordedInvocation[]> {
	if (!fs.existsSync(logFilePath)) return [];
	const content = await readFile(logFilePath, "utf8");
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as RecordedInvocation);
}

beforeEach(async () => {
	sandboxRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-agent-desktop-test-")));
	projectCwd = path.join(sandboxRoot, "project");
	agentDir = path.join(sandboxRoot, "agent");
	sessionDir = path.join(sandboxRoot, "sessions");
	fakeBinPath = path.join(sandboxRoot, "fake-agent-desktop");
	logFilePath = path.join(sandboxRoot, "invocations.jsonl");

	await Promise.all([
		mkdir(projectCwd, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
	]);
	await createFakeAgentDesktopBinary(fakeBinPath, logFilePath);

	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	prevDesktopBin = process.env.AGENT_DESKTOP_BIN;
	prevDesktopSession = process.env.AGENT_DESKTOP_SESSION;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.AGENT_DESKTOP_BIN = fakeBinPath;
	delete process.env.AGENT_DESKTOP_SESSION;

	delete (globalThis as Record<symbol, unknown>)[AGENT_DESKTOP_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
});

afterEach(async () => {
	delete (globalThis as Record<symbol, unknown>)[AGENT_DESKTOP_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];

	if (prevAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	}
	if (prevDesktopBin === undefined) {
		delete process.env.AGENT_DESKTOP_BIN;
	} else {
		process.env.AGENT_DESKTOP_BIN = prevDesktopBin;
	}
	if (prevDesktopSession === undefined) {
		delete process.env.AGENT_DESKTOP_SESSION;
	} else {
		process.env.AGENT_DESKTOP_SESSION = prevDesktopSession;
	}

	await rm(sandboxRoot, { recursive: true, force: true });
});

describe("1 — Skill discovery and frontmatter contracts", () => {
	it("discovers the agent-desktop skill via Pi's DefaultResourceLoader with valid frontmatter and workflow guidance", async () => {
		const loader = new DefaultResourceLoader({
			cwd: projectCwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
			noPromptTemplates: true,
			additionalSkillPaths: [skillsRoot],
		});
		await loader.reload();

		const { skills, diagnostics } = loader.getSkills();
		expect(diagnostics).toEqual([]);
		const matches = skills.filter((s) => s.name === "agent-desktop");
		expect(matches).toHaveLength(1);

		const [skill] = matches;
		expect(skill!.filePath).toBe(path.join(skillDir, "SKILL.md"));
		expect(skill!.baseDir).toBe(skillDir);
		expect(skill!.disableModelInvocation).toBe(false);
		expect(skill!.description).toContain("agent-desktop");

		const skillContent = await readFile(skill!.filePath, "utf8");
		expect(skillContent).toContain("agent_desktop");
		expect(skillContent).toContain("skills get desktop");
		expect(skillContent).toContain("skills get platform");
		expect(skillContent).toMatch(/@[A-Za-z0-9_<>-]+:e[A-Za-z0-9_<>-]+/);
		expect(skillContent).toContain("headed");
		expect(skillContent).toContain("--stdin");
		expect(skillContent).not.toContain(repoRoot);
	});
});

describe("2 — Argv parsing, session ID derivation, and status formatting", () => {
	it("derives sanitized Pi-scoped desktop session IDs within 1..64 [A-Za-z0-9_-] characters and falls back to pi-default", () => {
		expect(deriveDesktopSessionId()).toBe("pi-default");
		expect(deriveDesktopSessionId({ sessionId: "   " })).toBe("pi-default");
		expect(deriveDesktopSessionId({ sessionId: "!!!@@@" })).toBe("pi-default");
		expect(deriveDesktopSessionId({ sessionId: "abc-123_XYZ" })).toBe("pi-abc-123_XYZ");
		expect(
			deriveDesktopSessionId({
				sessionManager: { getSessionId: () => "session/with spaces & symbols!" },
			}),
		).toBe("pi-session-with-spaces-symbols");
		expect(
			deriveDesktopSessionId({
				sessionManager: { getSessionFile: () => "/tmp/sessions/2026-session-xyz.jsonl" },
			}),
		).toBe("pi-2026-session-xyz");

		const longDerived = deriveDesktopSessionId({ sessionId: "x".repeat(120) });
		expect(longDerived.startsWith("pi-")).toBe(true);
		expect(longDerived.length).toBeGreaterThanOrEqual(1);
		expect(longDerived.length).toBeLessThanOrEqual(64);
		expect(longDerived).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});

	it("parses global value flags, headed/stdin flags, session start/end, and screenshot flags vs positional path", () => {
		const globalFlagsParsed = parseAgentDesktopArgv([
			"--session",
			"custom-1",
			"--agent-id",
			"bot-1",
			"--wait-for",
			"button:Save",
			"-w",
			"window:Main",
			"--wait-timeout",
			"5000",
			"--screenshot",
			"after.png",
			"click",
			"@s1:e1",
		]);
		expect(globalFlagsParsed).toMatchObject({
			explicitSession: "custom-1",
			subcommand: "click",
			hasHeadedFlag: false,
			hasStdinFlag: false,
		});

		expect(parseAgentDesktopArgv(["--session=custom-2", "--headed", "click", "@s1:e1"])).toMatchObject({
			explicitSession: "custom-2",
			subcommand: "click",
			hasHeadedFlag: true,
			hasStdinFlag: false,
		});

		expect(parseAgentDesktopArgv(["--headed=true", "type", "@s1:e2", "--stdin"])).toMatchObject({
			subcommand: "type",
			hasHeadedFlag: true,
			hasStdinFlag: true,
		});

		expect(parseAgentDesktopArgv(["session", "start", "--app", "Notes"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "session",
			sessionAction: "start",
			sessionTargetId: undefined,
			screenshotPath: undefined,
		});
		expect(parseAgentDesktopArgv(["session", "end"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "session",
			sessionAction: "end",
			sessionTargetId: undefined,
			screenshotPath: undefined,
		});
		expect(parseAgentDesktopArgv(["session", "end", "sess-42"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "session",
			sessionAction: "end",
			sessionTargetId: "sess-42",
			screenshotPath: undefined,
		});

		const shotFlagsOnly = parseAgentDesktopArgv([
			"screenshot",
			"--app",
			"Finder",
			"--window-id",
			"42",
			"--screen",
			"0",
		]);
		expect(shotFlagsOnly.subcommand).toBe("screenshot");
		expect(shotFlagsOnly.screenshotPath).toBeUndefined();

		expect(parseAgentDesktopArgv(["screenshot", "--app", "Finder", "shots/finder.png"])).toMatchObject({
			subcommand: "screenshot",
			screenshotPath: "shots/finder.png",
		});
		expect(parseAgentDesktopArgv(["screenshot", "shots/finder.png", "--window-id", "42"])).toMatchObject({
			subcommand: "screenshot",
			screenshotPath: "shots/finder.png",
		});
	});

	it("formats desktop status and exports META_SUBCOMMANDS and PHYSICAL_SUBCOMMANDS", () => {
		expect(formatDesktopStatus(new Set())).toBeUndefined();
		expect(formatDesktopStatus(new Set(["pi-a"]))).toBe("desktop: pi-a");
		expect(formatDesktopStatus(new Set(["pi-a", "pi-b"]))).toBe("desktop: pi-a (+1)");
		expect(formatDesktopStatus(new Set(["pi-a", "pi-b", "pi-c"]))).toBe("desktop: pi-a (+2)");

		for (const cmd of ["status", "permissions", "skills"]) {
			expect(META_SUBCOMMANDS.has(cmd)).toBe(true);
		}
		for (const cmd of ["mouse-click", "double-click", "drag", "hover"]) {
			expect(PHYSICAL_SUBCOMMANDS.has(cmd)).toBe(true);
		}
	});
});

describe("3 — Direct execution (runAgentDesktop)", () => {
	it("executes with shell: false, isolates AGENT_DESKTOP_SESSION, and respects explicit --session or options.session", async () => {
		const markerPath = path.join(sandboxRoot, "pwned-marker");
		const literalArg = `@s1:e1 $(touch ${markerPath}); echo pwned`;
		const res = await runAgentDesktop({
			argv: ["click", literalArg],
			session: "pi-session-1",
			cwd: projectCwd,
		});
		expect(res.ok).toBe(true);
		expect(res.status).toBe("success");
		expect(res.session).toBe("pi-session-1");
		expect(fs.existsSync(markerPath)).toBe(false);

		const invocations = await readInvocations();
		expect(invocations).toHaveLength(1);
		expect(invocations[0]!.argv).toEqual(["click", literalArg]);
		expect(invocations[0]!.session).toBe("pi-session-1");

		const overrideRes = await runAgentDesktop({
			argv: ["--session", "override-sess", "snapshot", "--app", "Finder"],
			session: "pi-session-1",
			cwd: projectCwd,
		});
		expect(overrideRes.ok).toBe(true);
		expect(overrideRes.session).toBe("override-sess");
		expect((await readInvocations()).at(-1)?.session).toBe("override-sess");
	});

	it("normalizes placeholder arguments (blank argv items, blank/'none' session & cwd, timeoutMs: 0, and @-prefixed cwd)", async () => {
		const res = await runAgentDesktop({
			argv: ["status", "", "   "],
			session: "   ",
			cwd: "",
			stdin: "",
			timeoutMs: 0,
		});
		expect(res.ok).toBe(true);
		expect(res.status).toBe("success");
		expect(res.session).toBe("pi-default");

		const noneRes = await runAgentDesktop({
			argv: ["status"],
			session: "none",
			cwd: "none",
			timeoutMs: 0,
		});
		expect(noneRes.ok).toBe(true);
		expect(noneRes.session).toBe("pi-default");
		expect(noneRes.cwd).toBe(process.cwd());

		const atCwdRes = await runAgentDesktop({
			argv: ["status"],
			cwd: `@${projectCwd}`,
		});
		expect(atCwdRes.ok).toBe(true);
		expect(atCwdRes.cwd).toBe(projectCwd);

		const invocations = await readInvocations();
		expect(invocations[0]!.argv).toEqual(["status"]);
		expect(invocations[0]!.session).toBe("pi-default");
		expect(invocations[2]!.cwd).toBe(projectCwd);
	});

	it("enforces the headed gate against smuggled --headed flags and physical subcommands unless headed: true is set", async () => {
		const smuggledFront = await runAgentDesktop({
			argv: ["--headed", "click", "@s1:e1"],
			cwd: projectCwd,
		});
		expect(smuggledFront.ok).toBe(false);
		expect(smuggledFront.status).toBe("error");

		const smuggledBack = await runAgentDesktop({
			argv: ["click", "@s1:e1", "--headed"],
			cwd: projectCwd,
		});
		expect(smuggledBack.ok).toBe(false);
		expect(smuggledBack.status).toBe("error");

		const smuggledEq = await runAgentDesktop({
			argv: ["--headed=true", "click", "@s1:e1"],
			cwd: projectCwd,
		});
		expect(smuggledEq.ok).toBe(false);
		expect(smuggledEq.status).toBe("error");

		for (const cmd of ["mouse-click", "double-click", "drag", "hover"]) {
			const physDenied = await runAgentDesktop({
				argv: [cmd, "@s1:e1"],
				cwd: projectCwd,
			});
			expect(physDenied.ok).toBe(false);
			expect(physDenied.status).toBe("error");
		}

		// None of the rejected invocations may spawn the CLI process
		expect(await readInvocations()).toEqual([]);

		// Passing headed: true prepends --headed and succeeds
		const allowed = await runAgentDesktop({
			argv: ["mouse-click", "@s1:e1"],
			headed: true,
			cwd: projectCwd,
		});
		expect(allowed.ok).toBe(true);
		expect(allowed.status).toBe("success");

		const invocations = await readInvocations();
		expect(invocations).toHaveLength(1);
		expect(invocations[0]!.argv).toEqual(["--headed", "mouse-click", "@s1:e1"]);
	});

	it("pipes exact UTF-8 stdin without exposing secrets in argv and closes stdin immediately when omitted or empty", async () => {
		const secret = "secret line 1\nline 2 — café 🔐";
		const piped = await runAgentDesktop({
			argv: ["type", "@s1:e2", "--stdin"],
			stdin: secret,
			cwd: projectCwd,
		});
		expect(piped.ok).toBe(true);
		expect(piped.argv.join(" ")).not.toContain("secret line 1");

		const omittedStdin = await runAgentDesktop({
			argv: ["type", "@s1:e2", "--stdin"],
			cwd: projectCwd,
			timeoutMs: 3000,
		});
		expect(omittedStdin.ok).toBe(true);

		const emptyStdin = await runAgentDesktop({
			argv: ["type", "@s1:e2", "--stdin"],
			stdin: "",
			cwd: projectCwd,
			timeoutMs: 3000,
		});
		expect(emptyStdin.ok).toBe(true);

		const invocations = await readInvocations();
		expect(invocations).toHaveLength(3);
		expect(invocations[0]!.argv).toEqual(["type", "@s1:e2", "--stdin"]);
		expect(invocations[0]!.stdin).toBe(secret);
		expect(invocations[1]!.stdin).toBe("");
		expect(invocations[2]!.stdin).toBe("");
	});

	it("captures inline screenshots via temp file or explicit path, cleans up temp dir, and rejects JSON ok: false", async () => {
		// 1. Default screenshot without explicit path -> temp .png injected, returned inline, temp dir deleted
		const defaultShot = await runAgentDesktop({
			argv: ["screenshot", "--app", "Finder"],
			session: "pi-shot-test",
			cwd: projectCwd,
		});
		expect(defaultShot.ok).toBe(true);
		expect(defaultShot.image).toBeDefined();
		expect(defaultShot.image!.mimeType).toBe("image/png");
		expect(defaultShot.image!.data).toBe(ONE_BY_ONE_PNG_BASE64);
		expect(defaultShot.image!.path).toMatch(/\.png$/);
		expect(fs.existsSync(defaultShot.image!.path)).toBe(false);
		expect(fs.existsSync(path.dirname(defaultShot.image!.path))).toBe(false);

		// 2. Explicit output path -> kept on disk AND returned inline
		const customRelPath = "shots/finder.png";
		const customFullPath = path.join(projectCwd, customRelPath);
		const customShot = await runAgentDesktop({
			argv: ["screenshot", customRelPath, "--app", "Finder"],
			session: "pi-shot-test",
			cwd: projectCwd,
		});
		expect(customShot.ok).toBe(true);
		expect(customShot.image).toEqual({
			data: ONE_BY_ONE_PNG_BASE64,
			mimeType: "image/png",
			path: customFullPath,
		});
		expect(fs.existsSync(customFullPath)).toBe(true);

		// 3. JSON { ok: false } with exit 0 and exit 1 -> result.ok false, status "error", no bogus image
		for (const marker of ["ScreenDeniedExit0", "ScreenDeniedExit1"]) {
			const denied = await runAgentDesktop({
				argv: ["screenshot", customRelPath, "--app", marker],
				session: "pi-shot-test",
				cwd: projectCwd,
			});
			expect(denied.ok).toBe(false);
			expect(denied.status).toBe("error");
			expect(denied.image).toBeUndefined();
		}
	});

	it("settles promptly when a descendant holds stdout/stderr open, and handles timeout, truncation, and ENOENT", async () => {
		// Descendant holding stdio open settles within < 1500 ms
		const start = performance.now();
		const holdRes = await runAgentDesktop({
			argv: ["hold-stdio"],
			cwd: projectCwd,
			timeoutMs: 10_000,
		});
		const elapsedMs = performance.now() - start;
		try {
			const parsed = JSON.parse(holdRes.stdout.trim()) as { data?: { pid?: number } };
			if (parsed.data?.pid) {
				try {
					process.kill(parsed.data.pid, "SIGKILL");
				} catch {
					// Ignore if already exited
				}
			}
		} catch {
			// Ignore JSON parse error
		}
		expect(holdRes.ok).toBe(true);
		expect(elapsedMs).toBeLessThan(1500);

		// Output truncation (> MAX_RESULT_LINES)
		const floodRes = await runAgentDesktop({
			argv: ["flood"],
			cwd: projectCwd,
		});
		expect(floodRes.ok).toBe(true);
		expect(floodRes.status).toBe("truncated");
		expect(floodRes.stdoutTruncated).toBe(true);
		expect(floodRes.stdout.split("\n").length).toBeLessThanOrEqual(MAX_RESULT_LINES);

		// Timeout
		const timeoutRes = await runAgentDesktop({
			argv: ["hang"],
			cwd: projectCwd,
			timeoutMs: 150,
		});
		expect(timeoutRes.ok).toBe(false);
		expect(timeoutRes.status).toBe("timeout");

		// Missing binary (ENOENT)
		const missingRes = await runAgentDesktop({
			argv: ["status"],
			binary: path.join(sandboxRoot, "does-not-exist-agent-desktop"),
			cwd: projectCwd,
		});
		expect(missingRes.ok).toBe(false);
		expect(missingRes.status).toBe("unavailable");
		expect(missingRes.message).toBe(INSTALL_HINT);
		expect(missingRes.stderr).toContain(INSTALL_HINT);
	});

	it("AC-16 respects -- end-of-flags and --help/-h without misclassifying subcommands, targets, or headed gating", async () => {
		// Tokens after -- are positional, not flags
		expect(
			parseAgentDesktopArgv([
				"type",
				"@s1:e1",
				"--",
				"--headed",
				"--stdin",
				"--session",
				"fake-sess",
				"--help",
				"-h",
			]),
		).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "type",
			sessionAction: undefined,
			sessionTargetId: undefined,
			screenshotPath: undefined,
		});
		expect(parseAgentDesktopArgv(["screenshot", "--app", "Finder", "--", "--shot.png"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "screenshot",
			sessionAction: undefined,
			sessionTargetId: undefined,
			screenshotPath: "--shot.png",
		});
		expect(parseAgentDesktopArgv(["session", "end", "--", "--weird-id"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "session",
			sessionAction: "end",
			sessionTargetId: "--weird-id",
			screenshotPath: undefined,
		});
		expect(parseAgentDesktopArgv(["mouse-click", "--", "--help"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "mouse-click",
			sessionAction: undefined,
			sessionTargetId: undefined,
			screenshotPath: undefined,
		});
		expect(parseAgentDesktopArgv(["screenshot", "--", "--help"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "screenshot",
			sessionAction: undefined,
			sessionTargetId: undefined,
			screenshotPath: "--help",
		});
		expect(parseAgentDesktopArgv(["--", "click", "@s1:e1"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "click",
			sessionAction: undefined,
			sessionTargetId: undefined,
			screenshotPath: undefined,
		});

		// --help / -h before -- turns the invocation into help without physical/session/screenshot targets
		expect(parseAgentDesktopArgv(["mouse-click", "--help"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "--help",
			sessionAction: undefined,
			sessionTargetId: undefined,
			screenshotPath: undefined,
		});
		expect(parseAgentDesktopArgv(["double-click", "@s1:e1", "-h"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "-h",
			sessionAction: undefined,
			sessionTargetId: undefined,
			screenshotPath: undefined,
		});
		expect(parseAgentDesktopArgv(["screenshot", "existing.png", "--help"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "--help",
			sessionAction: undefined,
			sessionTargetId: undefined,
			screenshotPath: undefined,
		});
		expect(parseAgentDesktopArgv(["session", "end", "sess-1", "-h"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "-h",
			sessionAction: undefined,
			sessionTargetId: undefined,
			screenshotPath: undefined,
		});
		expect(parseAgentDesktopArgv(["--help", "screenshot", "out.png"])).toEqual({
			explicitSession: undefined,
			hasHeadedFlag: false,
			hasStdinFlag: false,
			subcommand: "--help",
			sessionAction: undefined,
			sessionTargetId: undefined,
			screenshotPath: undefined,
		});

		// Execution: physical subcommand with --help / -h must NOT fail the headed gate
		const physHelp = await runAgentDesktop({
			argv: ["mouse-click", "--help"],
			cwd: projectCwd,
		});
		expect(physHelp.ok).toBe(true);
		expect((await readInvocations()).at(-1)?.argv).toEqual(["mouse-click", "--help"]);

		const physShortHelpWithHeaded = await runAgentDesktop({
			argv: ["double-click", "-h"],
			headed: true,
			cwd: projectCwd,
		});
		expect(physShortHelpWithHeaded.ok).toBe(true);
		expect((await readInvocations()).at(-1)?.argv).toEqual(["double-click", "-h"]);

		// Execution: --help after -- is NOT help, so physical subcommand still enforces headed gate
		const physAfterDash = await runAgentDesktop({
			argv: ["mouse-click", "--", "--help"],
			cwd: projectCwd,
		});
		expect(physAfterDash.ok).toBe(false);
		expect(physAfterDash.status).toBe("error");

		// Execution: literal --headed after -- is allowed headlessly
		const literalHeaded = await runAgentDesktop({
			argv: ["type", "@s1:e1", "--", "--headed"],
			cwd: projectCwd,
		});
		expect(literalHeaded.ok).toBe(true);
		expect((await readInvocations()).at(-1)?.argv).toEqual(["type", "@s1:e1", "--", "--headed"]);

		// Execution: screenshot --help does not append a temp path or attach a pre-existing file
		const preExistingShot = path.join(projectCwd, "preexisting.png");
		await writeFile(preExistingShot, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

		const shotHelp = await runAgentDesktop({
			argv: ["screenshot", "--help"],
			cwd: projectCwd,
		});
		expect(shotHelp.ok).toBe(true);
		expect(shotHelp.image).toBeUndefined();
		expect((await readInvocations()).at(-1)?.argv).toEqual(["screenshot", "--help"]);

		const shotExistingHelp = await runAgentDesktop({
			argv: ["screenshot", "preexisting.png", "-h"],
			cwd: projectCwd,
		});
		expect(shotExistingHelp.ok).toBe(true);
		expect(shotExistingHelp.image).toBeUndefined();
		expect((await readInvocations()).at(-1)?.argv).toEqual(["screenshot", "preexisting.png", "-h"]);

		// Execution: screenshot -- --shot.png writes and attaches --shot.png
		const hyphenShot = await runAgentDesktop({
			argv: ["screenshot", "--", "--shot.png"],
			cwd: projectCwd,
		});
		expect(hyphenShot.ok).toBe(true);
		expect(hyphenShot.image).toBeDefined();
		expect(hyphenShot.image!.path).toBe(path.join(projectCwd, "--shot.png"));
		expect((await readInvocations()).at(-1)?.argv).toEqual(["screenshot", "--", "--shot.png"]);
	});

	it("AC-16 distinguishes missing or non-directory cwd from missing CLI binary on ENOENT", async () => {
		// Nonexistent cwd with valid binary -> working-directory error, NOT unavailable/INSTALL_HINT
		const missingCwd = path.join(sandboxRoot, "does-not-exist-dir");
		const missingCwdRes = await runAgentDesktop({
			argv: ["status"],
			cwd: missingCwd,
		});
		expect(missingCwdRes.ok).toBe(false);
		expect(missingCwdRes.status).toBe("error");
		expect(missingCwdRes.message).toContain("Working directory does not exist");
		expect(missingCwdRes.message).toContain(missingCwd);
		expect(missingCwdRes.stderr).not.toContain(INSTALL_HINT);

		// File path passed as cwd -> working-directory error, NOT unavailable/INSTALL_HINT
		const notADirPath = path.join(sandboxRoot, "not-a-dir.txt");
		await writeFile(notADirPath, "hello", "utf8");
		const notADirRes = await runAgentDesktop({
			argv: ["status"],
			cwd: notADirPath,
		});
		expect(notADirRes.ok).toBe(false);
		expect(notADirRes.status).toBe("error");
		expect(notADirRes.message).toContain("Working directory is not a directory");
		expect(notADirRes.message).toContain(notADirPath);
		expect(notADirRes.stderr).not.toContain(INSTALL_HINT);

		// Existing cwd with missing binary -> unavailable with INSTALL_HINT
		const missingBinRes = await runAgentDesktop({
			argv: ["status"],
			binary: path.join(sandboxRoot, "missing-agent-desktop-bin"),
			cwd: projectCwd,
		});
		expect(missingBinRes.ok).toBe(false);
		expect(missingBinRes.status).toBe("unavailable");
		expect(missingBinRes.message).toBe(INSTALL_HINT);
	});

	it("resolves and executes the bundled agent-desktop binary from node_modules when AGENT_DESKTOP_BIN is unset", async () => {
		const savedBin = process.env.AGENT_DESKTOP_BIN;
		delete process.env.AGENT_DESKTOP_BIN;
		try {
			const expectedBinDir = path.join("node_modules", "agent-desktop", "bin");
			const bundled = resolveBundledAgentDesktop();
			expect(bundled).toBeDefined();
			expect(bundled!.binary).toContain(expectedBinDir);
			expect(fs.existsSync(bundled!.binary)).toBe(true);
			if (os.platform() !== "win32") {
				expect(() => fs.accessSync(bundled!.binary, fs.constants.X_OK)).not.toThrow();
			}

			if (os.platform() === "darwin") {
				expect(bundled!.macosHelperPath).toBeDefined();
				expect(bundled!.macosHelperPath).toContain(expectedBinDir);
				expect(fs.existsSync(bundled!.macosHelperPath!)).toBe(true);
				expect(() => fs.accessSync(bundled!.macosHelperPath!, fs.constants.X_OK)).not.toThrow();
			} else {
				expect(bundled!.macosHelperPath).toBeUndefined();
			}

			expect(resolveBundledAgentDesktop("freebsd", "x64")).toBeUndefined();

			const res = await runAgentDesktop({ argv: ["version"], cwd: projectCwd });
			expect(res.ok).toBe(true);
			expect(res.status).toBe("success");
			expect(res.binary).toBe(bundled!.binary);

			const parsed = JSON.parse(res.stdout) as {
				ok: boolean;
				command: string;
				data: { version: string };
			};
			expect(parsed.command).toBe("version");
			expect(parsed.data.version).toBe("1.3.1");
			expect(await readInvocations()).toEqual([]);
		} finally {
			if (savedBin === undefined) {
				delete process.env.AGENT_DESKTOP_BIN;
			} else {
				process.env.AGENT_DESKTOP_BIN = savedBin;
			}
		}
	});
});

describe("4 — Real Pi session integration, UI status, session lifecycle, and /agent-desktop", () => {
	function createRecordingUi() {
		const notes: { message: string; type?: string }[] = [];
		const statusHistory: { key: string; value: string | undefined }[] = [];
		const currentStatuses = new Map<string, string | undefined>();
		const noop = () => {};
		const context = {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			editor: async () => undefined,
			custom: async () => undefined,
			onTerminalInput: () => noop,
			setWorkingMessage: noop,
			setWorkingVisible: noop,
			setWorkingIndicator: noop,
			setHiddenThinkingLabel: noop,
			setWidget: noop,
			setFooter: noop,
			setHeader: noop,
			setTitle: noop,
			pasteToEditor: noop,
			setEditorText: noop,
			getEditorText: () => "",
			addAutocompleteProvider: noop,
			setEditorComponent: noop,
			getEditorComponent: () => undefined,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "UI not available" }),
			getToolsExpanded: () => false,
			setToolsExpanded: noop,
			notify: (message: string, type?: string) => {
				notes.push({ message, type });
			},
			setStatus: (key: string, value: string | undefined) => {
				statusHistory.push({ key, value });
				if (value === undefined) currentStatuses.delete(key);
				else currentStatuses.set(key, value);
			},
		} as unknown as ExtensionUIContext;
		return { notes, statusHistory, currentStatuses, context };
	}

	async function startPiSession() {
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const faux = fauxProvider({
			api: "agent-desktop-test-api",
			provider: "agent-desktop-test",
			models: [{ id: "test" }],
		});
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false, keepRecentTokens: 1 },
		});
		const ui = createRecordingUi();
		let capturedApi: any;

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir: runtimeAgentDir,
				settingsManager,
				modelRuntime,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [extensionPath],
					extensionFactories: [
						(pi) => {
							capturedApi = pi;
							pi.registerProvider(faux.provider);
						},
					],
				},
			});
			expect(services.resourceLoader.getExtensions().errors).toEqual([]);
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel("test"),
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: projectCwd,
			agentDir,
			sessionManager: SessionManager.create(projectCwd, sessionDir),
		});

		const bind = () =>
			runtime.session.bindExtensions({
				mode: "rpc",
				uiContext: ui.context,
				commandContextActions: {
					waitForIdle: () => runtime.session.waitForIdle(),
					newSession: (o) => runtime.newSession(o),
					fork: (id, o) => runtime.fork(id, o),
					navigateTree: (id, o) => runtime.session.navigateTree(id, o),
					switchSession: (p, o) => runtime.switchSession(p, o),
					reload: () => runtime.session.reload(),
				},
			});
		runtime.setRebindSession(bind);
		await bind();

		return {
			runtime,
			get session() {
				return runtime.session;
			},
			faux,
			ui,
			getPiApi: () => capturedApi,
			toolResultMessages: () =>
				runtime.session.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "toolResult"
							? [
									entry.message as {
										isError?: boolean;
										content?: Array<{
											type: string;
											text?: string;
											data?: string;
											mimeType?: string;
										}>;
									},
								]
							: [],
					),
			commandEntries: () =>
				runtime.session.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom" && entry.customType === "pi-extensions.command")
					.map((entry) => (entry as { data?: unknown }).data),
			dispose: () => runtime.dispose(),
		};
	}

	it("registers agent_desktop and child-session hook, runs observe/act/screenshot, tracks sessions, handles /agent-desktop commands, and cleans up on switch/shutdown", async () => {
		const h = await startPiSession();
		let disposed = false;
		try {
			const piApi = h.getPiApi();
			expect(piApi.getAllTools().some((t: { name: string }) => t.name === "agent_desktop")).toBe(true);

			// Child-session hook is registered while session is open
			const hooks = (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS] as
				| Set<ChildSessionHook>
				| undefined;
			expect(hooks).toBeInstanceOf(Set);
			expect([...(hooks ?? [])].some((item) => item.name === "agent-desktop")).toBe(true);

			const expectedSession = deriveDesktopSessionId({
				sessionManager: h.session.sessionManager,
			});

			// 1. Meta subcommands (status, permissions, skills) must NOT mark desktop session active
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_desktop", { argv: ["status"] }),
					fauxToolCall("agent_desktop", { argv: ["permissions"] }),
					fauxToolCall("agent_desktop", { argv: ["skills", "get", "desktop"] }),
				]),
				fauxAssistantMessage("checked desktop status and skills"),
			]);
			await h.session.prompt("check desktop adapter and skills");
			expect(h.ui.currentStatuses.get(AGENT_DESKTOP_STATUS_KEY)).toBeUndefined();

			// 2. Observe (with placeholder args) -> act (stdin + --stdin) -> screenshot loop
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_desktop", {
						argv: ["snapshot", "--app", "Notes", "-i", ""],
						session: "",
						cwd: "",
						timeoutMs: 0,
						stdin: "",
					}),
				]),
				fauxAssistantMessage([
					fauxToolCall("agent_desktop", {
						argv: ["type", "@s1:e2", "--stdin"],
						stdin: "Confidential note\nLine two",
					}),
					fauxToolCall("agent_desktop", {
						argv: ["screenshot", "--app", "Notes"],
					}),
				]),
				fauxAssistantMessage("desktop sequence complete"),
			]);
			await h.session.prompt("inspect Notes, type text, and capture screenshot");

			expect(h.ui.currentStatuses.get(AGENT_DESKTOP_STATUS_KEY)).toBe(`desktop: ${expectedSession}`);

			const toolMessages = h.toolResultMessages();
			const screenshotMsg = toolMessages.find((m) =>
				(m.content ?? []).some((block) => block.type === "image"),
			);
			expect(screenshotMsg).toBeDefined();
			expect(screenshotMsg!.content!.find((block) => block.type === "image")).toEqual({
				type: "image",
				data: ONE_BY_ONE_PNG_BASE64,
				mimeType: "image/png",
			});

			let invocations = await readInvocations();
			expect(
				invocations.some(
					(inv) =>
						JSON.stringify(inv.argv) === JSON.stringify(["snapshot", "--app", "Notes", "-i"]) &&
						inv.session === expectedSession &&
						inv.cwd === projectCwd,
				),
			).toBe(true);
			expect(
				invocations.some(
					(inv) =>
						JSON.stringify(inv.argv) === JSON.stringify(["type", "@s1:e2", "--stdin"]) &&
						inv.stdin === "Confidential note\nLine two",
				),
			).toBe(true);

			// 3. Test /agent-desktop status, doctor, permissions --guide, and close
			await h.session.prompt("/agent-desktop status");
			expect(h.ui.notes.at(-1)?.message).toContain(expectedSession);

			await h.session.prompt("/agent-desktop doctor");
			expect(h.ui.notes.at(-1)?.message).toContain("macos-ax");

			await h.session.prompt("/agent-desktop permissions --guide");
			expect(h.ui.notes.at(-1)?.message).toContain("Accessibility");
			invocations = await readInvocations();
			expect(invocations.at(-1)?.argv).toEqual(["permissions", "--guide"]);

			const invBeforeCloseCmd = invocations.length;
			await h.session.prompt("/agent-desktop close");
			expect(h.ui.currentStatuses.get(AGENT_DESKTOP_STATUS_KEY)).toBeUndefined();
			expect(h.ui.notes.at(-1)?.message).toContain(expectedSession);

			invocations = await readInvocations();
			expect(
				invocations
					.slice(invBeforeCloseCmd)
					.some(
						(inv) =>
							inv.argv[0] === "--session" &&
							inv.argv[1] === expectedSession &&
							inv.argv[2] === "session" &&
							inv.argv[3] === "end",
					),
			).toBe(true);

			expect(h.commandEntries()).toEqual([
				{ command: "agent-desktop", kind: "extension", extension: "agent-desktop" },
				{ command: "agent-desktop", kind: "extension", extension: "agent-desktop" },
				{ command: "agent-desktop", kind: "extension", extension: "agent-desktop" },
				{ command: "agent-desktop", kind: "extension", extension: "agent-desktop" },
			]);

			// 4. Test `session start` capturing data.session_id from JSON, `session end [id]`, and session switch (newSession)
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_desktop", { argv: ["session", "start", "--app", "Finder"] }),
				]),
				fauxAssistantMessage("started finder session"),
			]);
			await h.session.prompt("start explicit desktop session");
			expect(h.ui.currentStatuses.get(AGENT_DESKTOP_STATUS_KEY)).toBe("desktop: sess-started-1");

			// End explicit session via tool call, then start again to verify newSession cleanup
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_desktop", { argv: ["session", "end", "sess-started-1"] }),
				]),
				fauxAssistantMessage("ended finder session"),
			]);
			await h.session.prompt("end explicit desktop session");
			expect(h.ui.currentStatuses.get(AGENT_DESKTOP_STATUS_KEY)).toBeUndefined();

			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_desktop", { argv: ["session", "start", "--app", "Finder"] }),
				]),
				fauxAssistantMessage("restarted finder session"),
			]);
			await h.session.prompt("restart explicit desktop session");
			expect(h.ui.currentStatuses.get(AGENT_DESKTOP_STATUS_KEY)).toBe("desktop: sess-started-1");

			const invBeforeSwitch = (await readInvocations()).length;
			await h.runtime.newSession();
			expect(h.ui.currentStatuses.get(AGENT_DESKTOP_STATUS_KEY)).toBeUndefined();

			invocations = await readInvocations();
			expect(
				invocations
					.slice(invBeforeSwitch)
					.some(
						(inv) =>
							inv.argv[0] === "--session" &&
							inv.argv[1] === "sess-started-1" &&
							inv.argv[2] === "session" &&
							inv.argv[3] === "end",
					),
			).toBe(true);

			// 5. Activate second session and verify shutdown (dispose) ends session and removes child-session hook
			const secondSession = deriveDesktopSessionId({
				sessionManager: h.session.sessionManager,
			});
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_desktop", { argv: ["snapshot", "--app", "Finder", "-i"] }),
				]),
				fauxAssistantMessage("inspected finder"),
			]);
			await h.session.prompt("inspect finder in second session");
			expect(h.ui.currentStatuses.get(AGENT_DESKTOP_STATUS_KEY)).toBe(`desktop: ${secondSession}`);

			const invBeforeDispose = (await readInvocations()).length;
			await h.dispose();
			disposed = true;

			invocations = await readInvocations();
			expect(
				invocations
					.slice(invBeforeDispose)
					.some(
						(inv) =>
							inv.argv[0] === "--session" &&
							inv.argv[1] === secondSession &&
							inv.argv[2] === "session" &&
							inv.argv[3] === "end",
					),
			).toBe(true);

			const hooksAfterDispose = (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS] as
				| Set<ChildSessionHook>
				| undefined;
			expect([...(hooksAfterDispose ?? [])].some((item) => item.name === "agent-desktop")).toBe(false);
		} finally {
			if (!disposed) {
				await h.dispose();
			}
		}
	});

	it("AC-16 treats blank session/cwd as omitted and preserves session tracking on --help in tool execute()", async () => {
		const h = await startPiSession();
		try {
			const expectedSession = deriveDesktopSessionId({
				sessionManager: h.session.sessionManager,
			});

			// 1. Physical subcommand --help and screenshot --help while idle do not fail headed gate,
			// do not attach an image, and do not mark session active
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_desktop", { argv: ["mouse-click", "--help"] }),
					fauxToolCall("agent_desktop", { argv: ["screenshot", "--help"] }),
				]),
				fauxAssistantMessage("shown desktop help"),
			]);
			await h.session.prompt("show desktop help");
			expect(h.ui.currentStatuses.get(AGENT_DESKTOP_STATUS_KEY)).toBeUndefined();
			expect(
				h.toolResultMessages().some((m) => (m.content ?? []).some((b) => b.type === "image")),
			).toBe(false);

			// 2. Blank/whitespace session and cwd fall back to derived session and session cwd
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_desktop", {
						argv: ["snapshot", "--app", "Finder", "-i"],
						session: "   ",
						cwd: "   ",
					}),
					fauxToolCall("agent_desktop", {
						argv: ["status"],
						session: "",
						cwd: "",
					}),
				]),
				fauxAssistantMessage("ran with blank session and cwd"),
			]);
			await h.session.prompt("run with blank session and cwd");
			expect(h.ui.currentStatuses.get(AGENT_DESKTOP_STATUS_KEY)).toBe(`desktop: ${expectedSession}`);

			const invocations = await readInvocations();
			const lastTwo = invocations.slice(-2);
			expect(lastTwo).toHaveLength(2);
			for (const inv of lastTwo) {
				expect(inv.session).toBe(expectedSession);
				expect(fs.realpathSync(inv.cwd)).toBe(fs.realpathSync(projectCwd));
			}

			// 3. session end --help while active does NOT drop active session tracking
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_desktop", { argv: ["session", "end", "--help"] }),
				]),
				fauxAssistantMessage("shown session end help"),
			]);
			await h.session.prompt("show session end help");
			expect(h.ui.currentStatuses.get(AGENT_DESKTOP_STATUS_KEY)).toBe(`desktop: ${expectedSession}`);
		} finally {
			await h.dispose();
		}
	});

	it("deduplicates binding to the same pi instance via WeakSet", () => {
		let toolCount = 0;
		let commandCount = 0;
		const fakePi = {
			on: () => () => {},
			registerTool: () => {
				toolCount++;
			},
			registerCommand: () => {
				commandCount++;
			},
		} as any;
		agentDesktopExtension(fakePi);
		agentDesktopExtension(fakePi);
		expect(toolCount).toBe(1);
		expect(commandCount).toBe(1);
	});
});

describe("5 — Package manifest and documentation contracts", () => {
	it("registers agent-desktop skill and extension in package.json before workspace, wires test:agent-desktop, and documents it", async () => {
		const [pkgRaw, extReadme] = await Promise.all([
			readFile(path.join(repoRoot, "package.json"), "utf8"),
			readFile(path.join(repoRoot, "extensions/agent-desktop/README.md"), "utf8"),
		]);

		const manifest = JSON.parse(pkgRaw) as {
			dependencies: Record<string, string>;
			scripts: Record<string, string>;
			pi: { skills: string[]; extensions: string[] };
		};

		expect(manifest.dependencies["agent-desktop"]).toBe("1.3.1");
		expect(manifest.scripts["test:agent-desktop"]).toBe("vitest run extensions/agent-desktop");
		expect(manifest.pi.skills).toContain("./extensions/agent-desktop/skills");

		const exts = manifest.pi.extensions;
		const agentDesktopIdx = exts.indexOf("./extensions/agent-desktop/index.ts");
		const workspaceIdx = exts.indexOf("./extensions/workspace/index.ts");

		expect(agentDesktopIdx).toBeGreaterThanOrEqual(0);
		expect(agentDesktopIdx).toBeLessThan(workspaceIdx);

		for (const expected of [
			"AGENT_DESKTOP_BIN",
			"skills get desktop",
			"skills get platform",
			"agent_desktop",
			"AGENT_DESKTOP_SESSION",
			"/agent-desktop status",
			"/agent-desktop close",
			"/agent-desktop permissions",
			"/agent-desktop doctor",
			"npm run test:agent-desktop",
		]) {
			expect(extReadme).toContain(expected);
		}
	});
});
