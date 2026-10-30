import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ENGINE_VERSION,
	parseChecksums,
	platformAsset,
	runEngine,
	truncateText,
} from "../src/engine.ts";
import { getLauncherPath, getSkillDir } from "../src/resources.ts";
import impeccableExtension from "../index.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";
import { ECHO_ENGINE, writeFakeEngine } from "./support/fake-engine.ts";

isolateEngineEnvironment();

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const onPosix = (name: string, fn: () => Promise<void>): ReturnType<typeof it> =>
	process.platform === "win32" ? it.skip(name, fn) : it(name, fn);

async function tempDir(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "pi impeccable engine with spaces-"));
}

describe("resources and checksums", () => {
	it("resolves the installed skill resources from the module, not the cwd", () => {
		expect(getSkillDir()).toBe(path.join(extensionRoot, "skills", "impeccable"));
		expect(getLauncherPath()).toBe(
			path.join(
				extensionRoot,
				"skills",
				"impeccable",
				"scripts",
				process.platform === "win32" ? "impeccable.cmd" : "impeccable",
			),
		);
	});

	it("pins ENGINE_VERSION to the upstream release", () => {
		expect(ENGINE_VERSION).toBe("0.1.18");
	});

	it("selects the released platform assets, including the windows-on-arm fallback", () => {
		expect(platformAsset("darwin", "arm64")).toEqual({ os: "darwin", arch: "arm64", asset: "impeccable-darwin-arm64" });
		expect(platformAsset("darwin", "x64")).toEqual({ os: "darwin", arch: "x64", asset: "impeccable-darwin-x64" });
		expect(platformAsset("linux", "arm64")).toEqual({ os: "linux", arch: "arm64", asset: "impeccable-linux-arm64" });
		expect(platformAsset("linux", "x64")).toEqual({ os: "linux", arch: "x64", asset: "impeccable-linux-x64" });
		expect(platformAsset("win32", "x64")).toEqual({ os: "windows", arch: "x64", asset: "impeccable-windows-x64.exe" });
		expect(platformAsset("win32", "arm64")).toEqual({ os: "windows", arch: "arm64", asset: "impeccable-windows-x64.exe" });
		expect(platformAsset("freebsd", "x64")).toBeNull();
		expect(platformAsset("linux", "ia32")).toBeNull();
	});

	it("parses checksums for the pinned version and ignores comments and other versions", () => {
		const parsed = parseChecksums(
			"# comment\n0.1.18 impeccable-darwin-arm64 abc123\n0.1.17 impeccable-darwin-arm64 deadbeef\n0.1.18 impeccable-linux-x64 456def\n",
			ENGINE_VERSION,
		);
		expect(parsed).toEqual(
			new Map([
				["impeccable-darwin-arm64", "abc123"],
				["impeccable-linux-x64", "456def"],
			]),
		);
	});

	it("head-truncates by whole lines and reports truncation", () => {
		expect(truncateText("one\ntwo\nthree", 1_000, 2)).toEqual({ text: "one\ntwo\n", truncated: true });
		expect(truncateText("short", 1_000, 10)).toEqual({ text: "short", truncated: false });
		expect(truncateText("a\nb\nc", 4, 10).truncated).toBe(true);
	});
});

describe("runEngine classification and ownership", () => {
	onPosix("runs the engine with direct argv, upstream env context, and the requested cwd", async () => {
		const dir = await tempDir();
		try {
			const binary = await writeFakeEngine(dir, "fake engine", ECHO_ENGINE);
			const result = await runEngine({ argv: ["context", "--target", "src/app with spaces", "$(literal)", "a;b"], cwd: dir, binary, env: { IMPECCABLE_TEST_LITERAL: "value with spaces $() ;" } });
			expect(result.status).toBe("success");
			expect(result.ok).toBe(true);
			expect(result.trustedOverride).toBe(true);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("ARGV:context --target src/app with spaces $(literal) a;b");
			expect(result.stdout).toContain("<context>\n<--target>\n<src/app with spaces>\n<$(literal)>\n<a;b>\n");
			expect(result.stdout).toContain("ENV:<value with spaces $() ;>");
			expect(result.stdout).toContain(`SKILL_DIR:${getSkillDir()}`);
			expect(result.stdout).toContain(`SELF:${getLauncherPath()}`);
			expect(result.stdout).toContain(`PWD:${await realpath(dir)}`);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	onPosix("classifies detector exit 2 as findings and other verbs' exit 2 as errors", async () => {
		const dir = await tempDir();
		try {
			const binary = await writeFakeEngine(dir, "exit-two", "#!/bin/sh\necho findings-or-gate >&2\nexit 2\n");
			const findings = await runEngine({ argv: ["detect", "src"], cwd: dir, binary });
			expect(findings.status).toBe("findings");
			expect(findings.findings).toBe(true);
			expect(findings.ok).toBe(true);
			expect(findings.stderr).toContain("findings-or-gate");

			const gate = await runEngine({ argv: ["build-phase", "advance"], cwd: dir, binary });
			expect(gate.status).toBe("error");
			expect(gate.findings).toBe(false);
			expect(gate.ok).toBe(false);
			expect(gate.stderr).toContain("findings-or-gate");

			const other = await runEngine({ argv: ["doctor"], cwd: dir, binary });
			expect(other.status).toBe("error");
			expect(other.findings).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	onPosix("preserves failure diagnostics for nonzero exits", async () => {
		const dir = await tempDir();
		try {
			const binary = await writeFakeEngine(dir, "fail", "#!/bin/sh\necho 'boom: engine setup failed' >&2\nexit 7\n");
			const result = await runEngine({ argv: ["context"], cwd: dir, binary });
			expect(result.status).toBe("error");
			expect(result.message).toContain("exited with code 7");
			expect(result.stderr).toContain("boom: engine setup failed");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	onPosix("kills a stalled child on cancellation and never returns success", async () => {
		const dir = await tempDir();
		try {
			const binary = await writeFakeEngine(dir, "stall", "#!/bin/sh\necho started\nsleep 60\n");
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 150);
			const result = await runEngine({ argv: ["context"], cwd: dir, binary, signal: controller.signal, timeoutMs: 10_000 });
			clearTimeout(timer);
			expect(result.status).toBe("cancelled");
			expect(result.ok).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	onPosix("times out a stalled child and never returns success", async () => {
		const dir = await tempDir();
		try {
			const binary = await writeFakeEngine(dir, "stall", "#!/bin/sh\necho started\nsleep 60\n");
			const result = await runEngine({ argv: ["context"], cwd: dir, binary, timeoutMs: 300 });
			expect(result.status).toBe("timeout");
			expect(result.ok).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	onPosix("bounds excess output and reports truncation instead of a clean success", async () => {
		const dir = await tempDir();
		try {
			const lines = Array.from({ length: 10_000 }, (_, index) => `line-${index}`).join("\n");
			const binary = await writeFakeEngine(dir, "noisy", `#!/bin/sh\nprintf '%s\\n' "${lines}"\nexit 0\n`);
			const result = await runEngine({ argv: ["detect"], cwd: dir, binary });
			expect(result.status).toBe("truncated");
			expect(result.ok).toBe(false);
			expect(result.stdoutTruncated).toBe(true);
			expect(result.stdout.length).toBeLessThan(60 * 1024);
			expect(result.stdout).not.toContain("line-9999");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports unsupported platforms as unavailable without downloading", async () => {
		const result = await runEngine({ argv: ["context"], platform: "freebsd", arch: "x64" });
		expect(result.status).toBe("unavailable");
		expect(result.kind).toBe("unsupported-platform");
		expect(result.ok).toBe(false);
	});
});

describe("non-destructive activation", () => {
	it("only registers capabilities and lifecycle handlers at activation", async () => {
		const registered: unknown[] = [];
		impeccableExtension({
			on() { return () => {}; },
			registerCommand() {},
			registerTool(tool: unknown) {
				registered.push(tool);
			},
		} as never);
		expect(registered.map((tool) => (tool as { name: string }).name)).toEqual(["impeccable_question", "impeccable_delegate", "impeccable_capabilities", "impeccable_live", "impeccable_run"]);
		const tool = registered[4] as { name: string; execute: unknown };
		expect(tool.name).toBe("impeccable_run");
		expect(typeof tool.execute).toBe("function");
	});
});
