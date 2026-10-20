import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

type Frame = Record<string, unknown>;
it("uses Pi 1.3's real RPC transport without a model call or a terminal hook", async () => {
	const root = mkdtempSync(join(tmpdir(), "orca-pi-rpc-compat-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const fixture = join(root, "activity-fixture.ts");
	writeFileSync(fixture, `export default function (pi) {
		globalThis.fetch = () => { throw new Error("Network forbidden in compatibility fixture"); };
		const publish = ids => pi.events.emit("pi-extensions:activity", {source:"compat",activities:ids.map(id=>({id,label:id}))});
		pi.registerCommand("compat-start", {handler: async () => publish(["agent", "workflow"])});
		pi.registerCommand("compat-partial", {handler: async () => publish(["workflow"])});
		pi.registerCommand("compat-finish", {handler: async () => publish([])});
		pi.registerCommand("compat-dialog", {handler: async (_args,ctx) => { await ctx.ui.confirm("Compatibility check", "Still running"); }});
	}`);
	const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
	const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--extension", resolve("extensions/orca-bridge/index.ts"), "--extension", fixture, "--session", join(root, "session.jsonl")], {
		cwd: root,
		env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ORCA_CLI_COMMAND: join(root, "missing-orca-cli"), NO_COLOR: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const frames: Frame[] = [];
	const waiting = new Set<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void; reject: (error: Error) => void }>();
	let buffer = "";
	let stderr = "";
	let sequence = 0;
	let closed = false;
	const exited = new Promise<void>(done => child.once("close", () => { closed = true; done(); }));
	const fail = (error: Error) => { for (const waiter of waiting) waiter.reject(error); waiting.clear(); };
	child.on("error", fail);
	child.once("exit", () => fail(new Error(`Pi exited before RPC reply: ${stderr.slice(-1500)}`)));
	child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-4000); });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		if (buffer.length > 2_000_000) { fail(new Error("Pi exceeded compatibility output limit")); child.kill(); return; }
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			try {
				const frame = JSON.parse(line) as Frame;
				frames.push(frame);
				for (const waiter of waiting) if (waiter.predicate(frame)) { waiting.delete(waiter); waiter.resolve(frame); }
			} catch { fail(new Error("Pi emitted non-JSON RPC output")); }
		}
	});
	function next(predicate: (frame: Frame) => boolean): Promise<Frame> {
		const seen = frames.find(predicate);
		if (seen) return Promise.resolve(seen);
		return new Promise((resolveFrame, reject) => {
			const timer = setTimeout(() => { waiting.delete(waiter); reject(new Error(`RPC compatibility timeout: ${stderr.slice(-1500)}`)); }, 15000);
			const waiter = { predicate, resolve: (frame: Frame) => { clearTimeout(timer); resolveFrame(frame); }, reject: (error: Error) => { clearTimeout(timer); reject(error); } };
			waiting.add(waiter);
		});
	}
	function request(type: string, extra: Frame = {}, expectSuccess = true): Promise<Frame> {
		const id = `request-${++sequence}`;
		const reply = next(frame => frame.type === "response" && frame.id === id);
		child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
		return reply.then(frame => { if (expectSuccess) expect(frame.success).toBe(true); return frame; });
	}
	const bridgeStatuses = () => frames.filter(frame => frame.type === "extension_ui_request" && frame.method === "setStatus" && String(frame.statusKey).startsWith("orca-bridge"));
	try {
		const commands = await request("get_commands");
		const commandData = commands.data as { commands: Array<{ name: string }> };
		expect(commandData.commands.map(command => command.name)).toEqual(expect.arrayContaining(["orca-open", "orca-diff", "orca-status"]));
		const navigationFailure = await request("prompt", { message: "/orca-open missing.md" }, false);
		const navigationErrors = frames.filter(frame => frame.type === "extension_error" || frame.method === "notify");
		expect(navigationFailure.success).toBe(true);
		expect(navigationErrors).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "extension_error", event: "command", extensionPath: "command:orca-open", error: expect.stringContaining("Orca") }),
		]));
		await request("prompt", { message: "/compat-start" });
		expect(bridgeStatuses()).toHaveLength(0);
		const state = (await request("get_state")).data as { isStreaming: boolean; pendingMessageCount: number };
		expect(state.isStreaming).toBe(false);
		expect(state.pendingMessageCount).toBe(0);
		await request("prompt", { message: "/compat-partial" });
		expect(bridgeStatuses()).toHaveLength(0);
		const dialogCommand = request("prompt", { message: "/compat-dialog" });
		const dialog = await next(frame => frame.type === "extension_ui_request" && frame.method === "confirm");
		child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: dialog.id, confirmed: true }) + "\n");
		await dialogCommand;
		await request("prompt", { message: "/compat-finish" });
		expect(bridgeStatuses()).toHaveLength(0);
		expect(frames.filter(frame => frame.type === "agent_start")).toHaveLength(0);
	} finally {
		fail(new Error("Compatibility fixture closed"));
		if (!closed) {
			child.kill("SIGTERM");
			const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
			await exited;
			clearTimeout(killTimer);
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);
