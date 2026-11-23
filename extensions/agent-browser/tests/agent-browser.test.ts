import * as fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import agentBrowserExtension, {
	AGENT_BROWSER_SHARED_KEY,
	AGENT_BROWSER_STATUS_KEY,
	CHILD_SESSION_HOOKS,
	deriveBrowserSessionId,
	formatBrowserStatus,
	INSTALL_HINT,
	MAX_RESULT_LINES,
	parseAgentBrowserArgv,
	runAgentBrowser,
	type ChildSessionHook,
} from "../index.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const skillsRoot = path.join(repoRoot, "extensions/agent-browser/skills");
const skillDir = path.join(skillsRoot, "agent-browser");

// Minimal valid 1x1 transparent PNG
const ONE_BY_ONE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface RecordedInvocation {
	argv: string[];
	cwd: string;
	session: string | undefined;
}

let sandboxRoot: string;
let projectCwd: string;
let agentDir: string;
let sessionDir: string;
let fakeBinPath: string;
let logFilePath: string;
let prevAgentDir: string | undefined;
let prevBrowserBin: string | undefined;

async function createFakeAgentBrowserBinary(binPath: string, logPath: string): Promise<void> {
	const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const record = {
	argv,
	cwd: process.cwd(),
	session: process.env.AGENT_BROWSER_SESSION,
};
const logFile = ${JSON.stringify(logPath)};
fs.appendFileSync(logFile, JSON.stringify(record) + "\\n", "utf8");

// Parse flags and subcommand
const valueFlags = new Set([
	"--session", "-s", "--session-name", "--cdp", "--provider", "-p", "--engine", "--config",
	"--namespace", "--profile", "--allowed-domains", "--idle-timeout",
	"--user-agent", "--proxy", "--proxy-bypass", "--headers",
	"--executable-path", "--extensions", "--args", "--state", "--download-path",
]);
const shotValueFlags = new Set(["--selector", "-S", "--format", "--quality", "-q", "--clip"]);

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
		if (valueFlags.has(tok)) {
			i++;
			continue;
		}
		if (subcommand === "screenshot" && shotValueFlags.has(tok)) {
			i++;
			continue;
		}
		if (tok === "--help" || tok === "-h") {
			isHelp = true;
			continue;
		}
		if (tok.startsWith("-")) continue;
	}
	if (subcommand === undefined) {
		subcommand = tok;
		subIdx = i;
	}
}

if (isHelp) {
	process.stdout.write("Usage: agent-browser " + (subcommand || "<command>") + " [options]\\n");
} else if (subcommand === "hang") {
	setTimeout(() => process.exit(0), 60000);
} else if (subcommand === "flood") {
	const lines = [];
	for (let i = 0; i < 2500; i++) {
		lines.push("line-" + i + "-payload");
	}
	process.stdout.write(lines.join("\\n") + "\\n");
} else if (subcommand === "fail") {
	process.stderr.write("simulated browser error\\n");
	process.exitCode = 2;
} else if (subcommand === "doctor") {
	process.stdout.write("agent-browser doctor: OK (chromium ready)\\n");
} else if (subcommand === "skills") {
	process.stdout.write("# agent-browser core skill\\nopen -> snapshot -i -> click @e1 -> screenshot -> close\\n");
} else if (subcommand === "screenshot") {
	let targetPath;
	let shotEndOfFlags = false;
	for (let i = subIdx + 1; i < argv.length; i++) {
		const tok = argv[i];
		if (!shotEndOfFlags) {
			if (tok === "--") {
				shotEndOfFlags = true;
				continue;
			}
			if (valueFlags.has(tok) || shotValueFlags.has(tok)) {
				i++;
				continue;
			}
			if (tok.startsWith("-")) continue;
		}
		targetPath = tok;
		break;
	}
	if (targetPath) {
		const resolved = path.resolve(process.cwd(), targetPath);
		fs.mkdirSync(path.dirname(resolved), { recursive: true });
		fs.writeFileSync(resolved, Buffer.from(${JSON.stringify(ONE_BY_ONE_PNG_BASE64)}, "base64"));
		process.stdout.write("Saved screenshot to " + resolved + "\\n");
	} else {
		process.stdout.write("Screenshot captured\\n");
	}
} else if (subcommand === "snapshot") {
	process.stdout.write("- document:\\n  - button \\"Submit\\" [@e1]\\n  - textbox \\"Search\\" [@e2]\\n");
} else {
	process.stdout.write(JSON.stringify({ ok: true, subcommand, argv, session: process.env.AGENT_BROWSER_SESSION }) + "\\n");
}
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
	sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "pi-agent-browser-test-"));
	projectCwd = path.join(sandboxRoot, "project");
	agentDir = path.join(sandboxRoot, "agent");
	sessionDir = path.join(sandboxRoot, "sessions");
	fakeBinPath = path.join(sandboxRoot, "fake-agent-browser");
	logFilePath = path.join(sandboxRoot, "invocations.jsonl");

	await Promise.all([
		mkdir(projectCwd, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
	]);
	await createFakeAgentBrowserBinary(fakeBinPath, logFilePath);

	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	prevBrowserBin = process.env.AGENT_BROWSER_BIN;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.AGENT_BROWSER_BIN = fakeBinPath;

	delete (globalThis as Record<symbol, unknown>)[AGENT_BROWSER_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
});

afterEach(async () => {
	delete (globalThis as Record<symbol, unknown>)[AGENT_BROWSER_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];

	if (prevAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	}
	if (prevBrowserBin === undefined) {
		delete process.env.AGENT_BROWSER_BIN;
	} else {
		process.env.AGENT_BROWSER_BIN = prevBrowserBin;
	}

	await rm(sandboxRoot, { recursive: true, force: true });
});

describe("AC-1 — Skill discovery and frontmatter contracts", () => {
	it("discovers the agent-browser skill via Pi's DefaultResourceLoader with valid frontmatter and workflow guidance", async () => {
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
		const matches = skills.filter((s) => s.name === "agent-browser");
		expect(matches).toHaveLength(1);

		const [skill] = matches;
		expect(skill!.filePath).toBe(path.join(skillDir, "SKILL.md"));
		expect(skill!.baseDir).toBe(skillDir);
		expect(skill!.disableModelInvocation).toBe(false);
		expect(skill!.description).toContain("Browser automation");
		expect(skill!.description).toContain("agent-browser");

		const skillContent = await readFile(skill!.filePath, "utf8");
		expect(skillContent).toContain("skills get core");
		expect(skillContent).toContain('["skills", "get", "core"]');
		expect(skillContent).toContain("agent_browser");
		expect(skillContent).toContain("snapshot -i");
		expect(skillContent).toContain("@e1");
		expect(skillContent).toContain("screenshot");
		expect(skillContent).toContain("close");
		expect(skillContent).not.toContain(repoRoot);
	});
});

describe("AC-2 & AC-3 — Direct argv execution, session isolation, and inline screenshots", () => {
	it("derives deterministic Pi-scoped browser session IDs and parses argv flags and screenshot paths", () => {
		expect(deriveBrowserSessionId()).toBe("pi-default");
		expect(deriveBrowserSessionId({ sessionId: "abc-123" })).toBe("pi-abc-123");
		expect(
			deriveBrowserSessionId({
				sessionManager: { getSessionId: () => "session/with spaces & symbols!" },
			}),
		).toBe("pi-session-with-spaces-symbols");
		expect(
			deriveBrowserSessionId({
				sessionManager: { getSessionFile: () => "/tmp/sessions/2026-session-xyz.jsonl" },
			}),
		).toBe("pi-2026-session-xyz");

		expect(parseAgentBrowserArgv(["open", "https://example.com"])).toEqual({
			explicitSession: undefined,
			subcommand: "open",
			screenshotPath: undefined,
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["--session", "custom-1", "snapshot", "-i"])).toEqual({
			explicitSession: "custom-1",
			subcommand: "snapshot",
			screenshotPath: undefined,
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["--session=custom-2", "--headed", "click", "@e1"])).toEqual({
			explicitSession: "custom-2",
			subcommand: "click",
			screenshotPath: undefined,
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["screenshot", "--full", "--selector", "#app", "out/shot.png"])).toEqual({
			explicitSession: undefined,
			subcommand: "screenshot",
			screenshotPath: "out/shot.png",
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["screenshot", "--base64"])).toEqual({
			explicitSession: undefined,
			subcommand: "screenshot",
			screenshotPath: undefined,
			screenshotBase64: true,
		});
	});

	it("consumes values for all 7 additional global value flags before and after subcommands", async () => {
		const flagCases: ReadonlyArray<readonly [flag: string, value: string]> = [
			["--session-name", "persisted-auth"],
			["--executable-path", "/usr/bin/chromium"],
			["--extensions", "/ext/one,/ext/two"],
			["--args", "--disable-gpu,--no-sandbox"],
			["--proxy-bypass", "localhost,127.0.0.1"],
			["--state", "auth/state.json"],
			["--download-path", "/tmp/downloads"],
		];

		for (const [flag, value] of flagCases) {
			// Space-separated before regular subcommand
			expect(parseAgentBrowserArgv([flag, value, "open", "https://example.com"])).toEqual({
				explicitSession: undefined,
				subcommand: "open",
				screenshotPath: undefined,
				screenshotBase64: false,
			});

			// Equals-separated before regular subcommand
			expect(parseAgentBrowserArgv([`${flag}=${value}`, "open", "https://example.com"])).toEqual({
				explicitSession: undefined,
				subcommand: "open",
				screenshotPath: undefined,
				screenshotBase64: false,
			});

			// Space-separated before screenshot (no explicit path)
			expect(parseAgentBrowserArgv([flag, value, "screenshot"])).toEqual({
				explicitSession: undefined,
				subcommand: "screenshot",
				screenshotPath: undefined,
				screenshotBase64: false,
			});

			// Equals-separated before screenshot with explicit path
			expect(parseAgentBrowserArgv([`${flag}=${value}`, "screenshot", "out/shot.png"])).toEqual({
				explicitSession: undefined,
				subcommand: "screenshot",
				screenshotPath: "out/shot.png",
				screenshotBase64: false,
			});

			// Space-separated after screenshot does not consume value as screenshotPath
			expect(parseAgentBrowserArgv(["screenshot", flag, value, "out/shot.png"])).toEqual({
				explicitSession: undefined,
				subcommand: "screenshot",
				screenshotPath: "out/shot.png",
				screenshotBase64: false,
			});

			// Space-separated before meta-subcommand (close)
			expect(parseAgentBrowserArgv([flag, value, "close"])).toEqual({
				explicitSession: undefined,
				subcommand: "close",
				screenshotPath: undefined,
				screenshotBase64: false,
			});

			// Equals-separated before meta-subcommand (close)
			expect(parseAgentBrowserArgv([`${flag}=${value}`, "close"])).toEqual({
				explicitSession: undefined,
				subcommand: "close",
				screenshotPath: undefined,
				screenshotBase64: false,
			});
		}

		// Multiple global value flags chained together with --session
		expect(
			parseAgentBrowserArgv([
				"--session-name",
				"work",
				"--executable-path",
				"/opt/chrome",
				"--extensions",
				"/ext/a",
				"--args",
				"--headless=new",
				"--proxy-bypass",
				"*.internal",
				"--state",
				"state.json",
				"--download-path",
				"/tmp/dl",
				"--session",
				"explicit-1",
				"screenshot",
				"out/combined.png",
			]),
		).toEqual({
			explicitSession: "explicit-1",
			subcommand: "screenshot",
			screenshotPath: "out/combined.png",
			screenshotBase64: false,
		});

		// End-to-end check: runAgentBrowser still captures inline screenshot and prepends --session for close
		const shotRes = await runAgentBrowser({
			argv: ["--download-path", "/tmp/downloads", "screenshot"],
			session: "pi-flag-test",
			cwd: projectCwd,
		});
		expect(shotRes.ok).toBe(true);
		expect(shotRes.subcommand).toBe("screenshot");
		expect(shotRes.image).toBeDefined();
		expect(shotRes.image!.data).toBe(ONE_BY_ONE_PNG_BASE64);

		const closeRes = await runAgentBrowser({
			argv: ["--session-name", "persisted-auth", "close"],
			session: "pi-flag-test",
			cwd: projectCwd,
		});
		expect(closeRes.ok).toBe(true);
		expect(closeRes.subcommand).toBe("close");
		const invocations = await readInvocations();
		expect(invocations.at(-1)?.argv).toEqual([
			"--session",
			"pi-flag-test",
			"--session-name",
			"persisted-auth",
			"close",
		]);
	});

	it("executes agent-browser without shell expansion, isolates AGENT_BROWSER_SESSION, and enforces timeout, truncation, and ENOENT install hints", async () => {
		const literalArg = "https://example.com/?q=$(echo injected);rm -rf /";
		const res = await runAgentBrowser({
			argv: ["open", literalArg],
			session: "pi-session-1",
			cwd: projectCwd,
		});
		expect(res.ok).toBe(true);
		expect(res.status).toBe("success");
		expect(res.session).toBe("pi-session-1");

		const invocations = await readInvocations();
		expect(invocations).toHaveLength(1);
		expect(invocations[0]!.argv).toEqual(["open", literalArg]);
		expect(invocations[0]!.session).toBe("pi-session-1");

		// Explicit --session in argv overrides options.session
		const overrideRes = await runAgentBrowser({
			argv: ["--session", "override-sess", "snapshot", "-i"],
			session: "pi-session-1",
			cwd: projectCwd,
		});
		expect(overrideRes.ok).toBe(true);
		expect(overrideRes.session).toBe("override-sess");

		// Output truncation
		const floodRes = await runAgentBrowser({
			argv: ["flood"],
			session: "pi-session-1",
			cwd: projectCwd,
		});
		expect(floodRes.ok).toBe(true);
		expect(floodRes.status).toBe("truncated");
		expect(floodRes.stdoutTruncated).toBe(true);
		expect(floodRes.stdout.split("\n").length).toBeLessThanOrEqual(MAX_RESULT_LINES);

		// Timeout
		const timeoutRes = await runAgentBrowser({
			argv: ["hang"],
			session: "pi-session-1",
			cwd: projectCwd,
			timeoutMs: 150,
		});
		expect(timeoutRes.ok).toBe(false);
		expect(timeoutRes.status).toBe("timeout");

		// Missing binary (ENOENT)
		const missingRes = await runAgentBrowser({
			argv: ["open", "https://example.com"],
			binary: path.join(sandboxRoot, "does-not-exist-agent-browser"),
			cwd: projectCwd,
		});
		expect(missingRes.ok).toBe(false);
		expect(missingRes.status).toBe("unavailable");
		expect(missingRes.message).toBe(INSTALL_HINT);
		expect(missingRes.stderr).toContain("npm install -g agent-browser && agent-browser install");
	});

	it("AC-3 captures screenshots via temporary file (cleaned up afterward) or caller-supplied path and returns inline image data", async () => {
		// 1. Default screenshot without explicit path -> temp file created, read, and deleted
		const defaultShot = await runAgentBrowser({
			argv: ["screenshot"],
			session: "pi-shot-test",
			cwd: projectCwd,
		});
		expect(defaultShot.ok).toBe(true);
		expect(defaultShot.image).toBeDefined();
		expect(defaultShot.image!.mimeType).toBe("image/png");
		expect(defaultShot.image!.data).toBe(ONE_BY_ONE_PNG_BASE64);
		// Temp file must be cleaned up in finally
		expect(fs.existsSync(defaultShot.image!.path)).toBe(false);
		expect(fs.existsSync(path.dirname(defaultShot.image!.path))).toBe(false);

		// 2. Caller-supplied path -> file kept on disk and returned inline
		const customRelPath = "artifacts/custom-shot.png";
		const customFullPath = path.join(projectCwd, customRelPath);
		const customShot = await runAgentBrowser({
			argv: ["screenshot", customRelPath],
			session: "pi-shot-test",
			cwd: projectCwd,
		});
		expect(customShot.ok).toBe(true);
		expect(customShot.image).toBeDefined();
		expect(customShot.image!.mimeType).toBe("image/png");
		expect(customShot.image!.data).toBe(ONE_BY_ONE_PNG_BASE64);
		expect(customShot.image!.path).toBe(customFullPath);
		expect(fs.existsSync(customFullPath)).toBe(true);
	});

	it("AC-16 respects -- end-of-flags and --help/-h without misclassifying subcommands or targets", async () => {
		// Tokens after -- are positional, not flags
		expect(parseAgentBrowserArgv(["screenshot", "--", "--hyphen.png"])).toEqual({
			explicitSession: undefined,
			subcommand: "screenshot",
			screenshotPath: "--hyphen.png",
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["screenshot", "--", "--base64"])).toEqual({
			explicitSession: undefined,
			subcommand: "screenshot",
			screenshotPath: "--base64",
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["screenshot", "--", "--session", "fake-sess"])).toEqual({
			explicitSession: undefined,
			subcommand: "screenshot",
			screenshotPath: "--session",
			screenshotBase64: false,
		});
		expect(
			parseAgentBrowserArgv([
				"--session",
				"real-sess",
				"fill",
				"@e1",
				"--",
				"--session",
				"fake-sess",
				"-s",
				"fake-short",
				"--help",
				"-h",
			]),
		).toEqual({
			explicitSession: "real-sess",
			subcommand: "fill",
			screenshotPath: undefined,
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["--", "open", "https://example.com"])).toEqual({
			explicitSession: undefined,
			subcommand: "open",
			screenshotPath: undefined,
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["screenshot", "--", "--help"])).toEqual({
			explicitSession: undefined,
			subcommand: "screenshot",
			screenshotPath: "--help",
			screenshotBase64: false,
		});

		// --help / -h before -- turns the invocation into help without screenshot/close targets
		expect(parseAgentBrowserArgv(["screenshot", "--help"])).toEqual({
			explicitSession: undefined,
			subcommand: "--help",
			screenshotPath: undefined,
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["screenshot", "existing.png", "-h"])).toEqual({
			explicitSession: undefined,
			subcommand: "-h",
			screenshotPath: undefined,
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["screenshot", "--base64", "--help"])).toEqual({
			explicitSession: undefined,
			subcommand: "--help",
			screenshotPath: undefined,
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["close", "--help"])).toEqual({
			explicitSession: undefined,
			subcommand: "--help",
			screenshotPath: undefined,
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["close", "-h"])).toEqual({
			explicitSession: undefined,
			subcommand: "-h",
			screenshotPath: undefined,
			screenshotBase64: false,
		});
		expect(parseAgentBrowserArgv(["--help", "screenshot", "out.png"])).toEqual({
			explicitSession: undefined,
			subcommand: "--help",
			screenshotPath: undefined,
			screenshotBase64: false,
		});

		// Execution: screenshot --help must not append a temp path or attach an existing image
		const preExistingShot = path.join(projectCwd, "preexisting.png");
		await writeFile(preExistingShot, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

		const shotHelp = await runAgentBrowser({
			argv: ["screenshot", "--help"],
			session: "pi-help-test",
			cwd: projectCwd,
		});
		expect(shotHelp.ok).toBe(true);
		expect(shotHelp.image).toBeUndefined();
		expect((await readInvocations()).at(-1)?.argv).toEqual(["screenshot", "--help"]);

		const shotExistingHelp = await runAgentBrowser({
			argv: ["screenshot", "preexisting.png", "-h"],
			session: "pi-help-test",
			cwd: projectCwd,
		});
		expect(shotExistingHelp.ok).toBe(true);
		expect(shotExistingHelp.image).toBeUndefined();
		expect((await readInvocations()).at(-1)?.argv).toEqual(["screenshot", "preexisting.png", "-h"]);

		// Execution: close --help must not prepend --session
		const closeHelp = await runAgentBrowser({
			argv: ["close", "--help"],
			session: "pi-help-test",
			cwd: projectCwd,
		});
		expect(closeHelp.ok).toBe(true);
		expect((await readInvocations()).at(-1)?.argv).toEqual(["close", "--help"]);

		// Execution: screenshot -- --hyphen.png treats --hyphen.png as the target path
		const hyphenShot = await runAgentBrowser({
			argv: ["screenshot", "--", "--hyphen.png"],
			session: "pi-help-test",
			cwd: projectCwd,
		});
		expect(hyphenShot.ok).toBe(true);
		expect(hyphenShot.image).toBeDefined();
		expect(hyphenShot.image!.path).toBe(path.join(projectCwd, "--hyphen.png"));
		expect((await readInvocations()).at(-1)?.argv).toEqual(["screenshot", "--", "--hyphen.png"]);
	});

	it("AC-16 normalizes blank session/cwd and distinguishes missing cwd from missing CLI on ENOENT", async () => {
		// Blank session/cwd treated as omitted
		const blankRes = await runAgentBrowser({
			argv: ["doctor"],
			session: "   ",
			cwd: "   ",
		});
		expect(blankRes.ok).toBe(true);
		expect(blankRes.session).toBe("pi-default");
		expect(blankRes.cwd).toBe(process.cwd());

		// Nonexistent cwd with valid binary -> working-directory error, NOT unavailable/INSTALL_HINT
		const missingCwd = path.join(sandboxRoot, "does-not-exist-dir");
		const missingCwdRes = await runAgentBrowser({
			argv: ["doctor"],
			cwd: missingCwd,
		});
		expect(missingCwdRes.ok).toBe(false);
		expect(missingCwdRes.status).toBe("error");
		expect(missingCwdRes.message).toContain("Working directory does not exist");
		expect(missingCwdRes.message).toContain(missingCwd);
		expect(missingCwdRes.stderr).not.toContain("npm install -g agent-browser");

		// File path passed as cwd -> working-directory error, NOT unavailable/INSTALL_HINT
		const notADirPath = path.join(sandboxRoot, "not-a-dir.txt");
		await writeFile(notADirPath, "hello", "utf8");
		const notADirRes = await runAgentBrowser({
			argv: ["doctor"],
			cwd: notADirPath,
		});
		expect(notADirRes.ok).toBe(false);
		expect(notADirRes.status).toBe("error");
		expect(notADirRes.message).toContain("Working directory is not a directory");
		expect(notADirRes.message).toContain(notADirPath);
		expect(notADirRes.stderr).not.toContain("npm install -g agent-browser");

		// Existing cwd with missing binary -> unavailable with INSTALL_HINT
		const missingBinRes = await runAgentBrowser({
			argv: ["doctor"],
			binary: path.join(sandboxRoot, "missing-agent-browser-bin"),
			cwd: projectCwd,
		});
		expect(missingBinRes.ok).toBe(false);
		expect(missingBinRes.status).toBe("unavailable");
		expect(missingBinRes.message).toBe(INSTALL_HINT);
	});
});

describe("AC-2, AC-3, AC-4 — Real Pi session integration, UI status, daemon cleanup, and /agent-browser", () => {
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
			api: "agent-browser-test-api",
			provider: "agent-browser-test",
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
							? [entry.message as { isError?: boolean; content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }]
							: [],
					),
			dispose: () => runtime.dispose(),
		};
	}

	it("registers agent_browser, publishes UI status, returns inline screenshots, and closes daemons on close/switch/shutdown", async () => {
		const h = await startPiSession();
		try {
			const piApi = h.getPiApi();
			expect(piApi.getAllTools()).toContainEqual(
				expect.objectContaining({ name: "agent_browser" }),
			);

			// Child-session hook is registered
			const hooks = (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS] as Set<ChildSessionHook> | undefined;
			expect(hooks).toBeInstanceOf(Set);
			expect([...(hooks ?? [])].some((item) => item.name === "agent-browser")).toBe(true);

			const expectedSession = deriveBrowserSessionId({
				sessionManager: h.session.sessionManager,
			});

			// 1. Run skills get core (meta command -> does not activate browser status), open, snapshot, screenshot
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_browser", { argv: ["skills", "get", "core"] }),
				]),
				fauxAssistantMessage([
					fauxToolCall("agent_browser", { argv: ["open", "https://example.com"] }),
					fauxToolCall("agent_browser", { argv: ["snapshot", "-i"] }),
					fauxToolCall("agent_browser", { argv: ["screenshot"] }),
				]),
				fauxAssistantMessage("browser sequence complete"),
			]);
			await h.session.prompt("open example.com and take screenshot");

			// UI status should show active browser session
			expect(h.ui.currentStatuses.get(AGENT_BROWSER_STATUS_KEY)).toBe(`browser: ${expectedSession}`);

			// Tool results should include inline image block from screenshot
			const toolMessages = h.toolResultMessages();
			const screenshotMsg = toolMessages.find((m) =>
				(m.content ?? []).some((block) => block.type === "image"),
			);
			expect(screenshotMsg).toBeDefined();
			const imgBlock = screenshotMsg!.content!.find((block) => block.type === "image");
			expect(imgBlock).toEqual({
				type: "image",
				data: ONE_BY_ONE_PNG_BASE64,
				mimeType: "image/png",
			});

			// 2. Test /agent-browser status and /agent-browser doctor
			await h.session.prompt("/agent-browser status");
			expect(h.ui.notes.at(-1)?.message).toContain(`Agent Browser: active (${expectedSession}`);

			await h.session.prompt("/agent-browser doctor");
			expect(h.ui.notes.at(-1)?.message).toContain("agent-browser doctor: OK");

			// 3. Test closing via agent_browser tool with ["close"]
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("agent_browser", { argv: ["close"] })]),
				fauxAssistantMessage("closed browser"),
			]);
			await h.session.prompt("close the browser");
			expect(h.ui.currentStatuses.get(AGENT_BROWSER_STATUS_KEY)).toBeUndefined();

			let invocations = await readInvocations();
			expect(
				invocations.some(
					(inv) =>
						inv.argv.includes("close") &&
						inv.argv.includes("--session") &&
						inv.session === expectedSession,
				),
			).toBe(true);

			// 4. Open again and verify session switch (newSession -> session_before_switch) closes the daemon and clears status
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_browser", { argv: ["open", "https://example.com/page2"] }),
				]),
				fauxAssistantMessage("opened page 2"),
			]);
			await h.session.prompt("open page 2");
			expect(h.ui.currentStatuses.get(AGENT_BROWSER_STATUS_KEY)).toBe(`browser: ${expectedSession}`);

			const invCountBeforeSwitch = (await readInvocations()).length;
			await h.runtime.newSession();
			expect(h.ui.currentStatuses.get(AGENT_BROWSER_STATUS_KEY)).toBeUndefined();

			invocations = await readInvocations();
			expect(invocations.length).toBeGreaterThan(invCountBeforeSwitch);
			expect(invocations.at(-1)?.argv).toEqual(["--session", expectedSession, "close"]);

			// 5. In the new session, test /agent-browser close
			const secondSession = deriveBrowserSessionId({
				sessionManager: h.session.sessionManager,
			});
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_browser", { argv: ["open", "https://example.com/page3"] }),
				]),
				fauxAssistantMessage("opened page 3"),
			]);
			await h.session.prompt("open page 3");
			expect(h.ui.currentStatuses.get(AGENT_BROWSER_STATUS_KEY)).toBe(`browser: ${secondSession}`);

			await h.session.prompt("/agent-browser close");
			expect(h.ui.notes.at(-1)?.message).toContain(`Closed agent-browser session(s): ${secondSession}`);
			expect(h.ui.currentStatuses.get(AGENT_BROWSER_STATUS_KEY)).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});

	it("AC-16 treats blank session/cwd as omitted and keeps session tracking intact on --help in tool execute()", async () => {
		const h = await startPiSession();
		try {
			const expectedSession = deriveBrowserSessionId({
				sessionManager: h.session.sessionManager,
			});

			// 1. screenshot --help while idle does not mark session active or attach an image
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("agent_browser", { argv: ["screenshot", "--help"] })]),
				fauxAssistantMessage("shown help"),
			]);
			await h.session.prompt("show screenshot help");
			expect(h.ui.currentStatuses.get(AGENT_BROWSER_STATUS_KEY)).toBeUndefined();
			expect(
				h.toolResultMessages().some((m) => (m.content ?? []).some((b) => b.type === "image")),
			).toBe(false);

			// 2. Blank/whitespace session and cwd fall back to derived session and session cwd
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("agent_browser", {
						argv: ["open", "https://example.com"],
						session: "   ",
						cwd: "   ",
					}),
					fauxToolCall("agent_browser", {
						argv: ["snapshot", "-i"],
						session: "",
						cwd: "",
					}),
				]),
				fauxAssistantMessage("opened with default session and cwd"),
			]);
			await h.session.prompt("open with blank session and cwd");
			expect(h.ui.currentStatuses.get(AGENT_BROWSER_STATUS_KEY)).toBe(`browser: ${expectedSession}`);

			const invocations = await readInvocations();
			const lastTwo = invocations.slice(-2);
			expect(lastTwo).toHaveLength(2);
			for (const inv of lastTwo) {
				expect(inv.session).toBe(expectedSession);
				expect(fs.realpathSync(inv.cwd)).toBe(fs.realpathSync(projectCwd));
			}

			// 3. close --help while active does NOT drop active session tracking
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("agent_browser", { argv: ["close", "--help"] })]),
				fauxAssistantMessage("shown close help"),
			]);
			await h.session.prompt("show close help");
			expect(h.ui.currentStatuses.get(AGENT_BROWSER_STATUS_KEY)).toBe(`browser: ${expectedSession}`);
		} finally {
			await h.dispose();
		}
	});

	it("deduplicates binding to the same pi instance via WeakSet and formats multi-session status", () => {
		expect(formatBrowserStatus(new Set())).toBeUndefined();
		expect(formatBrowserStatus(new Set(["pi-a"]))).toBe("browser: pi-a");
		expect(formatBrowserStatus(new Set(["pi-a", "pi-b", "pi-c"]))).toBe("browser: pi-a (+2)");

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
		agentBrowserExtension(fakePi);
		agentBrowserExtension(fakePi);
		expect(toolCount).toBe(1);
		expect(commandCount).toBe(1);
	});
});

describe("AC-5 — Repository manifest and documentation contracts", () => {
	it("registers agent-browser skill and extension in package.json before workspace, wires test:agent-browser, and documents it", async () => {
		const [pkgRaw, extReadme] = await Promise.all([
			readFile(path.join(repoRoot, "package.json"), "utf8"),
			readFile(path.join(repoRoot, "extensions/agent-browser/README.md"), "utf8"),
		]);

		const manifest = JSON.parse(pkgRaw) as {
			scripts: Record<string, string>;
			dependencies: Record<string, string>;
			pi: { skills: string[]; extensions: string[] };
		};

		expect(manifest.scripts["test:agent-browser"]).toBe("vitest run extensions/agent-browser");
		expect(manifest.pi.skills).toContain("./extensions/agent-browser/skills");

		const exts = manifest.pi.extensions;
		const agentBrowserIdx = exts.indexOf("./extensions/agent-browser/index.ts");
		const workspaceIdx = exts.indexOf("./extensions/workspace/index.ts");

		expect(agentBrowserIdx).toBeGreaterThanOrEqual(0);
		expect(agentBrowserIdx).toBeLessThan(workspaceIdx);

		for (const expected of [
			"npm install -g agent-browser && agent-browser install",
			"skills get core",
			"agent_browser",
			"AGENT_BROWSER_SESSION",
			"/agent-browser status",
			"/agent-browser close",
			"/agent-browser doctor",
			"npm run test:agent-browser",
		]) {
			expect(extReadme).toContain(expected);
		}
	});
});
