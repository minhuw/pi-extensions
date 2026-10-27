import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { MockIngest } from "./support/ingest-server.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A pi TUI in a detached tmux session on a private server, driven by keys and read by screen captures. */
class Terminal {
	private readonly socket = `pika-test-${process.pid}-${randomBytes(4).toString("hex")}`;
	private readonly target = "pika";
	private socketPath?: string;

	tmux(...args: string[]): string {
		const result = spawnSync("tmux", ["-L", this.socket, ...args], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`tmux ${args[0]} failed: ${result.stderr}`);
		return result.stdout;
	}

	start(config: string, cwd: string, command: string): void {
		this.tmux("-f", config, "new-session", "-d", "-s", this.target, "-x", "120", "-y", "40", "-c", cwd, command);
		this.socketPath = this.tmux("display-message", "-p", "#{socket_path}").trim();
	}

	/** The visible screen and the scrollback, without colours. */
	screen(): string { return this.tmux("capture-pane", "-p", "-S", "-", "-t", this.target); }
	/** Sends each character as its own key press. */
	type(text: string): void { for (const char of text) this.tmux("send-keys", "-t", this.target, "-l", char); }
	key(name: string): void { this.tmux("send-keys", "-t", this.target, name); }
	/** Pastes `text` with bracketed paste, as a terminal does when the application asked for it. */
	paste(text: string): void {
		this.tmux("set-buffer", "-b", "pika-paste", text);
		this.tmux("paste-buffer", "-p", "-d", "-b", "pika-paste", "-t", this.target);
	}

	async waitFor(check: (screen: string) => boolean, label: string, timeoutMs = 15_000): Promise<string> {
		const started = Date.now();
		for (;;) {
			const screen = this.screen();
			if (check(screen)) return screen;
			if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}; the screen was:\n${screen}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	/** Stops the server and removes its socket, which tmux leaves behind. */
	kill(): void {
		spawnSync("tmux", ["-L", this.socket, "kill-server"]);
		if (this.socketPath) rmSync(this.socketPath, { force: true });
	}
}

/** Every 8-character piece of `secret`, so a partly rendered secret is caught too. */
const pieces = (secret: string) => Array.from({ length: secret.length - 7 }, (_, at) => secret.slice(at, at + 8));
const expectHidden = (screen: string, secrets: string[]) => {
	for (const secret of secrets) for (const piece of pieces(secret)) expect(screen).not.toContain(piece);
};

it.skipIf(!hasTmux)("masks the token in a real terminal and shows the pairing code and page", async () => {
	// No "pika" in the paths pi shows, so only the extension can put that word on the screen.
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-tmux-")));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const ingest = await new MockIngest().start();
	ingest.pairInterval = 1;
	const terminal = new Terminal();
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		const config = join(root, "tmux.conf");
		// The pane stays after pi exits, so a crash shows on the captured screen.
		await writeFile(config, "set -g remain-on-exit on\nset -g history-limit 10000\n");
		const env = { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
		const pi = [
			process.execPath, join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
			"--no-extensions", "-e", join(REPO, "extensions", "pika", "index.ts"), "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
		];
		const command = ["env", "-u", "PIKA_URL", "-u", "PIKA_TOKEN", "-u", "PIKA_DISABLED", ...Object.entries(env).map(([name, value]) => `${name}=${value}`), ...pi].map(quote).join(" ");
		terminal.start(config, cwd, command);
		await terminal.waitFor((screen) => screen.includes(cwd), "pi to start");
		expect(cwd).not.toContain("pika");
		// The extension loaded: its status command answers. Pi lists the extension by name at startup, so that does not count.
		terminal.type("/pika");
		terminal.key("Enter");
		await terminal.waitFor((screen) => screen.replace(/\s+/g, " ").includes("pika is disabled: no server url and token configured"), "the /pika status");

		// Paste a token: typed key by key, then the rest pasted.
		const token = `pika_${randomBytes(32).toString("hex")}`;
		ingest.tokens.add(token);
		terminal.type(`/pika login ${ingest.url}`);
		terminal.key("Enter");
		await terminal.waitFor((screen) => screen.includes("How should this machine log in?") && screen.includes("Paste a token"), "the method choice");
		terminal.key("Down");
		terminal.key("Enter");
		await terminal.waitFor((screen) => screen.includes(`pika token for ${ingest.url}`), "the token prompt");
		const typed = token.slice(0, 20);
		terminal.type(typed);
		let screen = await terminal.waitFor((text) => text.includes("•".repeat(typed.length)), "a bullet per typed character");
		expect(screen).not.toContain("•".repeat(typed.length + 1));
		expectHidden(screen, [token]);
		terminal.paste(token.slice(typed.length));
		screen = await terminal.waitFor((text) => text.includes("•".repeat(token.length)), "a bullet per pasted character");
		expect(screen).not.toContain("•".repeat(token.length + 1));
		expectHidden(screen, [token]);
		terminal.key("Enter");
		screen = await terminal.waitFor((text) => text.includes(`Logged in to ${ingest.url}; saved to`), "the token login");
		expectHidden(screen, [token]);
		const file = join(agentDir, "pika.json");
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ url: ingest.url, token });
		expect((await stat(file)).mode & 0o777).toBe(0o600);

		// Pair with the web UI: the code and the page show, and approving logs in.
		terminal.type(`/pika login ${ingest.url}`);
		terminal.key("Enter");
		await terminal.waitFor((screen) => /How should this machine log in\?[\s\S]*→ Pair with the pika web UI/.test(screen.slice(screen.lastIndexOf("How should")))
			&& screen.lastIndexOf("How should") > screen.lastIndexOf("Logged in to"), "the method choice again");
		terminal.key("Enter");
		await terminal.waitFor((screen) => screen.includes("Name for this machine in pika"), "the device name prompt");
		terminal.type("tmux-pair");
		terminal.key("Enter");
		screen = await terminal.waitFor((text) => /Code: [A-Z2-9]{4}-[A-Z2-9]{4}/.test(text), "the pairing code");
		const code = /Code: ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(screen)![1]!;
		expect(screen).toContain(`${ingest.url}/devices?pair=${code}`);
		expect(screen).toMatch(/expires in \d+:\d\d · Esc cancels/);
		expect(ingest.pendingPairings().map((pairing) => pairing.code)).toEqual([code]);
		expect(ingest.approve(code)).toBe(200);
		screen = await terminal.waitFor((text) => text.includes(`Logged in to ${ingest.url} as tmux-pair; saved to`), "the paired login");
		const paired = ingest.deviceNamed("tmux-pair").token!;
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ url: ingest.url, token: paired });
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expectHidden(screen, [token, paired, ...ingest.pairingIds]);
	} finally {
		terminal.kill();
		await ingest.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);
