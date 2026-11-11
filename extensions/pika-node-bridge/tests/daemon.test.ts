/**
 * The extension against the real daemon in `services/pika-node` (`pika-node start` with a temporary
 * PIKA_NODE_HOME). It needs that package's dependencies (`npm ci` there, which builds node-pty); the root
 * package does not install them, so without them this suite is skipped.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_ENV } from "../compatibility.ts";
import { LineDecoder } from "../protocol.ts";
import { harness, tempDir, until } from "./support.ts";

const SERVICE = fileURLToPath(new URL("../../../services/pika-node/", import.meta.url));
const BIN = join(SERVICE, "bin", "pika-node");
const installed = ["node-pty", "@xterm/headless", "@xterm/addon-serialize"].every(name => existsSync(join(SERVICE, "node_modules", name, "package.json")));
const title = installed
	? "real pika-node daemon"
	: "real pika-node daemon (skipped: services/pika-node/node_modules is missing; run `npm ci` in services/pika-node)";

type Message = Record<string, unknown> & { type: string };

describe.skipIf(!installed)(title, () => {
	const dir = tempDir();
	const home = join(dir.path, "home");
	const project = join(dir.path, "project");
	const socketPath = join(home, "run", "daemon.sock");
	const cli = (args: string[]) => execFileSync(BIN, args, { env: { ...process.env, PIKA_NODE_HOME: home }, encoding: "utf8", timeout: 30_000 });
	let client: Socket;
	const inbox: Message[] = [];
	let nextId = 0;
	const request = async (type: string, params: object): Promise<Message> => {
		const id = `r${++nextId}`;
		client.write(`${JSON.stringify({ type, id, ...params })}\n`);
		await until(() => inbox.some(m => m.type === "reply" && m.id === id), 15_000, `reply to ${type}`);
		return inbox.find(m => m.type === "reply" && m.id === id)!;
	};

	beforeAll(async () => {
		mkdirSync(home, { recursive: true, mode: 0o700 });
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "notes.txt"), "hello\n");
		writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, roots: [project] }));
		expect(cli(["start"])).toMatch(/daemon started/);
		client = connect(socketPath);
		await new Promise<void>((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
		const decoder = new LineDecoder();
		client.setEncoding("utf8");
		client.on("data", (chunk: string) => { for (const line of decoder.push(chunk)) inbox.push(JSON.parse(line)); });
		client.write(`${JSON.stringify({ type: "hello", role: "client", version: "test", protocolVersion: 1 })}\n`);
		await until(() => inbox.some(m => m.type === "welcome"), 10_000, "welcome");
	}, 40_000);

	afterAll(() => {
		client?.destroy();
		try { cli(["stop"]); } finally { dir.cleanup(); }
	});

	it("reports status into the daemon's merged pane view and gets open/diff contained", async () => {
		const created = await request("term.create", { cols: 80, rows: 24, argv: ["/bin/sleep", "300"] });
		const terminalId = ((created.result as { terminal: { terminalId: string } }).terminal).terminalId;
		const saved = { socket: process.env.PIKA_NODE_SOCKET, pane: process.env.PIKA_NODE_PANE_ID, owner: process.env[OWNER_ENV] };
		Object.assign(process.env, { PIKA_NODE_SOCKET: socketPath, PIKA_NODE_PANE_ID: terminalId });
		delete process.env[OWNER_ENV];
		const h = harness({ session: { id: "real-1", name: "Real daemon", cwd: project } });
		const status = () => inbox.filter(m => m.type === "pane.status" && m.terminalId === terminalId).at(-1)?.status as
			{ state: string; bridgeConnected: boolean; bridge?: { activityCount: number; session?: { id: string } } } | null | undefined;
		try {
			await h.fire("session_start");
			await until(() => status()?.bridgeConnected === true, 10_000, "bridge connected");
			expect(status()).toMatchObject({ state: "idle", bridge: { session: { id: "real-1" } } });

			await h.fire("agent_start");
			await until(() => status()?.state === "busy", 5000, "busy");
			await h.fire("agent_settled");
			h.snapshot("subagents", ["a1", "recon"]);
			await until(() => status()?.bridge?.activityCount === 1, 5000, "activity");
			// Activities keep the pane busy after the root settled (the daemon's merge rule).
			expect(status()?.state).toBe("busy");
			h.snapshot("subagents");
			await until(() => status()?.state === "idle", 5000, "idle");

			await h.command("pika-open", "notes.txt --line 1");
			const opened = inbox.find(m => m.type === "pane.open" && m.terminalId === terminalId);
			expect(opened).toMatchObject({ path: join(realpathSync(project), "notes.txt"), line: 1 });
			expect(h.notify).toHaveBeenLastCalledWith("Sent notes.txt to 1 pika window.", "info");

			await h.command("pika-diff", "gone.ts --staged");
			expect(inbox.find(m => m.type === "pane.diff" && m.terminalId === terminalId)).toMatchObject({ path: join(realpathSync(project), "gone.ts"), staged: true });

			await h.command("pika-open", "/etc/hosts");
			expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("pika open failed (outside_roots)"), "error");
			await h.command("pika-open", ".");
			expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("pika open failed (is_a_directory)"), "error");

			await h.fire("session_shutdown");
			await until(() => status()?.bridgeConnected === false, 5000, "bridge disconnected");
			expect(status()).toMatchObject({ state: "idle", bridge: { activityCount: 0 } });
		} finally {
			await h.fire("session_shutdown");
			for (const [key, value] of [["PIKA_NODE_SOCKET", saved.socket], ["PIKA_NODE_PANE_ID", saved.pane], [OWNER_ENV, saved.owner]] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await request("term.kill", { terminalId, signal: "SIGKILL" });
		}
	}, 40_000);
});
