import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNavigationCommands } from "../navigation.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
const paneId = "repo-full-id::/Workspace/Project";
const json = (value: unknown, code = 0): ExecResult => ({ stdout: JSON.stringify(value), stderr: "private-stderr-token", code, killed: false });
const current = (id = paneId) => json({ ok: true, result: { worktree: { id, path: "/Workspace/Project" } } });
const opened = (relativePath = "src/Result.ts") => json({ ok: true, result: { opened: true, relativePath } });
const failed = (code: string, exit = 0) => json({ ok: false, error: { code, message: "private-error-token", data: { token: "private-data-token" } } }, exit);

function harness(cwd = "/Workspace/Project/nested") {
	const commands = new Map<string, Command>();
	const exec = vi.fn<ExtensionAPI["exec"]>().mockImplementation(async (_command, args) => args[0] === "worktree" ? current() : opened());
	const notify = vi.fn<ExtensionCommandContext["ui"]["notify"]>();
	const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>((name, command) => { commands.set(name, command); });
	const api = { exec, registerCommand } satisfies Pick<ExtensionAPI, "exec" | "registerCommand">;
	const ctx = { cwd, ui: { notify } } as unknown as ExtensionCommandContext;
	registerNavigationCommands(api as unknown as ExtensionAPI);
	return {
		exec, notify, commands, ctx, api,
		run: (args: string, name = "orca-open") => commands.get(name)!.handler(args, ctx),
		error: () => { expect(notify).toHaveBeenCalledOnce(); expect(notify.mock.lastCall?.[1]).toBe("error"); },
	};
}

let platform: PropertyDescriptor;
beforeEach(() => {
	platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	vi.stubEnv("ORCA_WORKTREE_ID", paneId);
	vi.stubEnv("ORCA_CLI_COMMAND", undefined);
	vi.stubEnv("ORCA_WSL_CLI_DIR", undefined);
	vi.stubEnv("ORCA_CLI_BIN_DIR", undefined);
	vi.useFakeTimers();
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call"); }));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Object.defineProperty(process, "platform", platform);
});

describe("explicit navigation and workspace isolation", () => {
	it("only registers two user commands with no processes, tools, network or timers during registration", async () => {
		const h = harness();
		expect([...h.commands.keys()]).toEqual(["orca-open", "orca-diff"]);
		expect(h.exec).not.toHaveBeenCalled();
		expect(h.notify).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		await Promise.resolve();
		expect(h.exec).not.toHaveBeenCalled();
	});

	it("targets the full pane ID and cwd even when the desktop has another workspace focused", async () => {
		vi.stubEnv("ORCA_ACTIVE_WORKTREE", "another-desktop-tab");
		const h = harness();
		await h.run('"../Reports/Review Report.md" --line 42 --column 7');
		expect(h.exec).toHaveBeenCalledTimes(2);
		expect(h.exec).toHaveBeenNthCalledWith(1, "orca", ["worktree", "current", "--json"], { cwd: h.ctx.cwd, timeout: 10_000 });
		expect(h.exec).toHaveBeenNthCalledWith(2, "orca", [
			"file", "open", "--path", "/Workspace/Project/Reports/Review Report.md", "--worktree", `id:${paneId}`, "--json", "--line", "42", "--column", "7",
		], { cwd: h.ctx.cwd, timeout: 10_000 });
		expect(h.notify).toHaveBeenCalledExactlyOnceWith("Opened src/Result.ts in Orca.", "info");
		expect(fetch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([true, false])("discovers folder/nonrepo workspace identity from cwd (envelope: %s)", async envelope => {
		vi.stubEnv("ORCA_WORKTREE_ID", undefined);
		const h = harness("/Notes/My Folder/subdir");
		const current = { worktree: { id: "folder:/Notes/My Folder", path: "/Notes/My Folder", repoId: null } };
		h.exec.mockResolvedValueOnce(json(envelope ? { ok: true, result: current } : current));
		await h.run("report.md");
		expect(h.exec.mock.calls).toEqual([
			["orca", ["worktree", "current", "--json"], { cwd: h.ctx.cwd, timeout: 10_000 }],
			["orca", ["file", "open", "--path", "/Notes/My Folder/subdir/report.md", "--worktree", "id:folder:/Notes/My Folder", "--json"], { cwd: h.ctx.cwd, timeout: 10_000 }],
		]);
		expect(h.notify.mock.lastCall?.[1]).toBe("info");
	});

	it("preserves inherited remote/WSL routing and pane ID without local filesystem checks", async () => {
		vi.stubEnv("ORCA_WORKTREE_ID", "remote-repo::/srv/Case Sensitive");
		vi.stubEnv("ORCA_ENVIRONMENT", "paired-server");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		const h = harness("/srv/Case Sensitive");
		h.exec.mockResolvedValueOnce(current("remote-repo::/srv/Case Sensitive"));
		await h.run('"Deleted File.TS" --staged --focus', "orca-diff");
		expect(h.exec).toHaveBeenCalledTimes(2);
		expect(h.exec).toHaveBeenNthCalledWith(2, "orca", ["file", "diff", "--path", "/srv/Case Sensitive/Deleted File.TS", "--worktree", "id:remote-repo::/srv/Case Sensitive", "--json", "--staged", "--focus"], { cwd: h.ctx.cwd, timeout: 10_000 });
		expect(process.env.ORCA_ENVIRONMENT).toBe("paired-server");
	});

	it.each([undefined, paneId])("preserves host-qualified discovery identity with inherited ID %s", async inheritedId => {
		vi.stubEnv("ORCA_WORKTREE_ID", inheritedId);
		vi.stubEnv("ORCA_ENVIRONMENT", "paired-server");
		const h = harness("/srv/Project/nested");
		const key = "ssh:host-b::repo-full-id::/Workspace/Project";
		h.exec.mockResolvedValueOnce(json({ worktree: { id: paneId, path: "/srv/Project", identity: { key } } }));
		await h.run("file.ts");
		expect(h.exec.mock.calls).toEqual([
			["orca", ["worktree", "current", "--json"], { cwd: h.ctx.cwd, timeout: 10_000 }],
			["orca", ["file", "open", "--path", "/srv/Project/nested/file.ts", "--worktree", `identity:${key}`, "--json"], { cwd: h.ctx.cwd, timeout: 10_000 }],
		]);
		expect(h.notify.mock.lastCall?.[1]).toBe("info");
	});

	it("refuses discovery of a different workspace from the inherited full ID", async () => {
		const h = harness();
		h.exec.mockResolvedValueOnce(current("another-desktop-tab"));
		await h.run("file.ts");
		h.error();
		expect(h.exec).toHaveBeenCalledOnce();
		expect(h.notify.mock.lastCall?.[0]).toContain("different pane workspace");
	});

	it.each([null, "private-identity", [], {}, { key: "" }, { key: " " }, { key: "private\nidentity" }, { key: 42 }])("refuses malformed provided identity %# without guessing", async value => {
		const h = harness();
		h.exec.mockResolvedValueOnce(json({ worktree: { id: paneId, path: "/Workspace/Project", identity: value } }));
		await h.run("file.ts");
		h.error();
		expect(h.exec).toHaveBeenCalledOnce();
		expect(h.notify.mock.lastCall?.[0]).not.toContain("private");
	});

	it.each([true, false])("stops on stale pane discovery with inherited ID set: %s", async inherited => {
		vi.stubEnv("ORCA_WORKTREE_ID", inherited ? paneId : undefined);
		const h = harness();
		h.exec.mockResolvedValueOnce(failed("selector_not_found"));
		await h.run("file.ts");
		h.error();
		expect(h.exec).toHaveBeenCalledOnce();
		expect(h.notify.mock.lastCall?.[0]).toContain("no other target was tried");
	});

	it.each(["", "  ", "bad\nidentity"])("refuses invalid inherited identity %j without discovery", async id => {
		vi.stubEnv("ORCA_WORKTREE_ID", id);
		const h = harness();
		await h.run("file.ts");
		h.error();
		expect(h.exec).not.toHaveBeenCalled();
	});

	it.each([{}, { worktree: {} }, { worktree: { id: "id" } }, { worktree: { id: "", path: "/root" } }, { worktrees: [{ id: "a" }, { id: "b" }] }])("refuses missing or ambiguous discovery result %j", async current => {
		vi.stubEnv("ORCA_WORKTREE_ID", undefined);
		const h = harness();
		h.exec.mockResolvedValueOnce(json({ ok: true, result: current }));
		await h.run("file.ts");
		h.error();
		expect(h.exec).toHaveBeenCalledOnce();
	});

	it.each(["selector_not_found", "selector_ambiguous", "invalid_argument"])("stops after discovery refusal %s, including remote cwd refusal", async code => {
		vi.stubEnv("ORCA_WORKTREE_ID", undefined);
		vi.stubEnv("ORCA_ENVIRONMENT", "paired-server");
		const h = harness();
		h.exec.mockResolvedValueOnce(failed(code));
		await h.run("file.ts");
		h.error();
		expect(h.exec).toHaveBeenCalledOnce();
		expect(h.notify.mock.lastCall?.[0]).toContain(code);
	});
});

describe("bounded argument parsing", () => {
	it.each([
		['"A File.md" --focus', "A File.md"],
		["'A File.md'", "A File.md"],
		['"a\'b.md"', "a'b.md"],
		["'$(touch secret);`whoami`&*.md'", "$(touch secret);`whoami`&*.md"],
		['"A\\B.md"', "A\\B.md"],
		["-- --focus", "--focus"],
		["--focus -- '-leading dash.md'", "-leading dash.md"],
		['"/Absolute/Case File.md"', "/Absolute/Case File.md"],
	])("sends filename literally: %s", async (input, path) => {
		const h = harness();
		await h.run(input);
		const call = h.exec.mock.calls[1]!;
		expect(call[1].slice(0, 4)).toEqual(["file", "open", "--path", resolve(h.ctx.cwd, path)]);
		expect(call[1].includes("--focus")).toBe(input !== "-- --focus" && (input.startsWith("--focus") || input.endsWith(" --focus")));
		expect(h.exec).toHaveBeenCalledTimes(2);
	});

	it.each([
		"", '""', "one two", "'unclosed", '"unclosed', "file --unknown", "file --path other", "-leading",
		"file --staged", "file --focus=true", "file --focus --focus", "file --line", "file --column 1",
		"file --line 0", "file --line -1", "file --line 1.2", "file --line 1e3", "file --line NaN",
		"file --line 9007199254740992", "file --line 1 --column 0", "file --line 1 --line 2",
		"file --line --focus", "file --line=1", "file\0name", "x".repeat(16_385),
	])("rejects invalid open arguments without execution: %.60s", async input => {
		const h = harness();
		await h.run(input);
		h.error();
		expect(h.exec).not.toHaveBeenCalled();
	});

	it.each(["file --line 1", "file --column 1", "file --staged --staged", "file --json"])("rejects unsupported diff options: %s", async input => {
		const h = harness();
		await h.run(input, "orca-diff");
		h.error();
		expect(h.exec).not.toHaveBeenCalled();
	});

	it("accepts safe boundary positions and explicit focus", async () => {
		const h = harness();
		await h.run("--column 1 --line 9007199254740991 report.md --focus");
		expect(h.exec.mock.calls[1]?.[1].slice(-5)).toEqual(["--line", "9007199254740991", "--column", "1", "--focus"]);
	});

	it.each(["orca-open", "orca-diff"])("defaults to no focus and no staged flag for %s", async command => {
		const h = harness();
		await h.run("file.md", command);
		expect(h.exec.mock.calls[1]?.[1]).not.toContain("--focus");
		expect(h.exec.mock.calls[1]?.[1]).not.toContain("--staged");
	});
});

describe("inherited CLI launchers", () => {
	it.each([
		["linux", "/Orca Private/shim/orca"],
		["darwin", "/Applications/Orca App.app/Contents/Resources/bin/orca"],
		["win32", "C:\\Program Files\\Orca\\bin\\orca.cmd"],
		["win32", "C:\\Program Files\\Orca\\bin\\orca.exe"],
		["linux", "/Orca/$(literal);`command`/orca"],
	])("uses the supplied %s launcher as one literal command: %s", async (target, command) => {
		Object.defineProperty(process, "platform", { value: target, configurable: true });
		vi.stubEnv("ORCA_CLI_COMMAND", command);
		vi.stubEnv("ORCA_CLI_BIN_DIR", "invalid-ignored-directory");
		const h = harness();
		await h.run('"Spaced File.md"');
		expect(h.exec.mock.calls.map(call => call[0])).toEqual([command, command]);
		expect(h.exec.mock.calls[0]?.[1]).toEqual(["worktree", "current", "--json"]);
		expect(h.exec.mock.calls[1]?.[1].slice(0, 4)).toEqual(["file", "open", "--path", resolve(h.ctx.cwd, "Spaced File.md")]);
		expect(h.notify.mock.lastCall?.[1]).toBe("info");
	});

	it.each([
		["linux", "/Orca Private/cli/shim", "/Orca Private/cli/shim/orca"],
		["darwin", "/Applications/Orca App.app/bin", "/Applications/Orca App.app/bin/orca"],
		["win32", "C:\\Program Files\\Orca\\bin", "C:\\Program Files\\Orca\\bin\\orca.cmd"],
	])("uses the official shim directory on %s", async (target, binDir, command) => {
		Object.defineProperty(process, "platform", { value: target, configurable: true });
		vi.stubEnv("ORCA_CLI_BIN_DIR", binDir);
		const h = harness();
		// Simulate Linux with only the supplied orca shim installed (no orca-ide).
		h.exec.mockImplementation(async (executable, args) => {
			if (executable !== command) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return args[0] === "worktree" ? current() : opened();
		});
		await h.run("file.md");
		expect(h.exec.mock.calls.map(call => call[0])).toEqual([command, command]);
		expect(h.notify.mock.lastCall?.[1]).toBe("info");
	});

	it.each(["orca-ide", "orca-dev"])("resolves Orca's managed WSL launcher %s within the translated CLI directory", async command => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		vi.stubEnv("ORCA_CLI_COMMAND", command);
		vi.stubEnv("ORCA_WSL_CLI_DIR", "/mnt/c/Orca Managed CLI");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		const h = harness();
		await h.run("report.md");
		expect(h.exec).toHaveBeenCalledTimes(2);
		expect(h.exec.mock.calls.every(call => call[0] === `/mnt/c/Orca Managed CLI/${command}`)).toBe(true);
		expect(h.notify.mock.lastCall?.[1]).toBe("info");
	});

	it.each(["orca", "../orca-ide", "orca-ide --json"])("does not treat arbitrary WSL launcher text %j as a managed basename", async command => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		vi.stubEnv("ORCA_CLI_COMMAND", command);
		vi.stubEnv("ORCA_WSL_CLI_DIR", "/mnt/c/Orca CLI");
		const h = harness();
		await h.run("report.md");
		h.error();
		expect(h.exec).not.toHaveBeenCalled();
	});

	it.each(["ORCA_CLI_COMMAND", "ORCA_CLI_BIN_DIR"])("refuses invalid explicit %s without trying PATH", async variable => {
		for (const value of ["", " ", "private-relative/path", "/private/path\ncommand", '"/quoted launcher/orca"', "orca --private-flag"]) {
			vi.stubEnv(variable, value);
			const h = harness();
			await h.run("file.md");
			h.error();
			expect(h.exec).not.toHaveBeenCalled();
			expect(h.notify.mock.lastCall?.[0]).toContain("invalid");
			expect(h.notify.mock.lastCall?.[0]).not.toContain("private");
		}
	});

	it.each(["ENOENT", "EACCES", "response"])("does not replace a stale or failed supplied launcher: %s", async reason => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		vi.stubEnv("ORCA_CLI_COMMAND", "/private launcher/orca");
		vi.stubEnv("ORCA_CLI_BIN_DIR", "/another/shim");
		const h = harness();
		if (reason === "response") h.exec.mockResolvedValueOnce(failed("runtime_unavailable", 1));
		else h.exec.mockRejectedValueOnce(Object.assign(new Error("private exception"), { code: reason }));
		await h.run("file.md");
		h.error();
		expect(h.exec).toHaveBeenCalledExactlyOnceWith("/private launcher/orca", ["worktree", "current", "--json"], { cwd: h.ctx.cwd, timeout: 10_000 });
		expect(h.notify.mock.lastCall?.[0]).not.toContain("private");
	});

	it("never falls back to the GNOME screen reader when orca-ide is missing", async () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		const h = harness();
		h.exec.mockImplementation(async command => {
			if (command === "orca") return opened(); // Ambient GNOME binary must not be tried.
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});
		await h.run("file.md");
		h.error();
		expect(h.exec.mock.calls.map(call => call[0])).toEqual(["orca-ide"]);
	});
});

describe("CLI responses and redacted diagnostics", () => {
	it("rejects failed RPC commands because native Orca ignores notify decorations", async () => {
		const h = harness();
		Object.defineProperty(h.ctx, "mode", { value: "rpc" });
		h.exec.mockResolvedValueOnce(failed("renderer_unavailable"));
		await expect(h.run("report.md")).rejects.toThrow("renderer_unavailable");
		h.error();
		expect(h.notify.mock.lastCall?.[0]).not.toContain("private-error-token");
	});
	it.each(["darwin", "win32", "linux"])("uses the correct executable on %s without probing alternatives", async target => {
		Object.defineProperty(process, "platform", { value: target, configurable: true });
		const h = harness();
		h.exec.mockRejectedValueOnce(Object.assign(new Error("private-exception-token"), { code: "ENOENT" }));
		await h.run("file.md");
		h.error();
		expect(h.exec.mock.calls[0]?.[0]).toBe(target === "linux" ? "orca-ide" : "orca");
		expect(h.exec).toHaveBeenCalledOnce();
		expect(h.notify.mock.lastCall?.[0]).toContain("not found");
		expect(h.notify.mock.lastCall?.[0]).not.toContain("private");
	});

	it.each([
		failed("renderer_unavailable"), failed("selector_not_found", 1), failed("unrecognized-private-token"),
		json({ ok: true, error: { code: "renderer_unavailable" }, result: { opened: true } }),
		json({ ok: true, result: { opened: true, error: { code: "renderer_unavailable" } } }),
		json({ ok: true, result: { opened: false } }), json({ opened: "true" }), json({}), json(null),
		json({ ok: "true", result: { opened: true } }), json({ ok: true }), { ...opened("file.md"), code: 1 },
		{ stdout: "private-malformed-token", stderr: "private-stderr-token", code: 0, killed: false },
		{ stdout: "private-malformed-token", stderr: "private-stderr-token", code: 127, killed: false },
	])("never reports success for errors, malformed results or nonzero status: %#", async response => {
		const h = harness();
		h.exec.mockResolvedValueOnce(current()).mockResolvedValueOnce(response);
		await h.run("file.md");
		h.error();
		expect(h.exec).toHaveBeenCalledTimes(2);
		expect(h.notify.mock.lastCall?.[0]).not.toContain("private");
	});

	it("reports killed results before trusting JSON", async () => {
		const h = harness();
		h.exec.mockResolvedValueOnce(current()).mockResolvedValueOnce({ ...opened(), killed: true });
		await h.run("file.md");
		h.error();
		expect(h.notify.mock.lastCall?.[0]).toContain("timed out or was cancelled");
	});

	it("contains exceptions without leaking their text", async () => {
		const h = harness();
		h.exec.mockRejectedValueOnce(new Error("private-exception-token"));
		await h.run("file.md");
		h.error();
		expect(h.notify.mock.lastCall?.[0]).not.toContain("private");
	});

	it("shows renderer advice and never retries stale pane IDs against another workspace", async () => {
		const h = harness();
		h.exec.mockResolvedValueOnce(current()).mockResolvedValueOnce(failed("renderer_unavailable"));
		await h.run("file.md");
		expect(h.notify.mock.lastCall?.[0]).toContain("Open an Orca app window");
		expect(h.exec).toHaveBeenCalledTimes(2);
	});

	it("accepts direct success results and falls back to the requested path", async () => {
		const h = harness();
		h.exec.mockResolvedValueOnce(current()).mockResolvedValueOnce(json({ opened: true }));
		await h.run('"Existing Review.md"', "orca-diff");
		expect(h.notify).toHaveBeenCalledExactlyOnceWith("Opened diff for Existing Review.md in Orca.", "info");
	});

	it("escapes terminal control bytes only for display and tolerates unavailable UI", async () => {
		const h = harness();
		h.exec.mockResolvedValueOnce(current()).mockResolvedValueOnce(opened("a\u001b[31m.md"));
		await h.run("file.md");
		expect(h.notify.mock.lastCall?.[0]).toContain("a\\u001b[31m.md");
		h.notify.mockImplementation(() => { throw new Error("private-ui-token"); });
		await expect(h.run("file.md")).resolves.toBeUndefined();
	});
});
