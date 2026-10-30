import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { liveSession } from "../support/live-session.ts";
import { LiveOwner } from "../../src/live.ts";
import { ENGINE_VERSION, parseChecksums, resolveEngine, runEngine, sha256 } from "../../src/engine.ts";
import { getChecksumsPath } from "../../src/resources.ts";
import { alive, generateEvent, phase } from "../support/live-fixture.ts";
const exec = promisify(execFile);

/** Explicit native integration smoke. Authenticated HTTP injection is test input, never a production transport. */
it("bridges the verified engine's boot, poll, publication ack, journal recovery and completion without a browser", async () => {
	if (process.env.IMPECCABLE_BIN?.trim()) throw new Error("Unset IMPECCABLE_BIN: this smoke requires the verified release.");
	const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-impeccable-live-native-")));
	const root = path.join(temp, "project"); await fs.mkdir(path.join(root, ".impeccable/live"), { recursive: true });
	const html = '<!doctype html>\n<html><body>\n<h1 id="hero">Original</h1>\n</body></html>\n';
	await fs.writeFile(path.join(root, "index.html"), html);
	await fs.writeFile(path.join(root, "package.json"), '{"name":"disposable-ui","private":true}');
	await fs.writeFile(path.join(root, ".impeccable/live/config.json"), '{"files":["index.html"],"insertBefore":"</body>","commentSyntax":"html","cspChecked":true}');
	const app = createServer(async (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(await fs.readFile(path.join(root, "index.html"))); });
	await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
	const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
	const owners: LiveOwner[] = [];
	let runtime: Awaited<ReturnType<typeof liveSession>> | undefined;
	try {
		for (const key of Object.keys(process.env)) if (/^(IMPECCABLE_|GIT_|PI_)/.test(key)) vi.stubEnv(key, undefined);
		const isolated = { HOME: path.join(temp, "home"), USERPROFILE: path.join(temp, "home"), PI_CODING_AGENT_DIR: path.join(temp, "agent"), XDG_CONFIG_HOME: path.join(temp, "config"), XDG_CACHE_HOME: path.join(temp, "cache"), IMPECCABLE_HOME: path.join(temp, "engine") };
		for (const [key, dir] of Object.entries(isolated)) { await fs.mkdir(dir, { recursive: true }); vi.stubEnv(key, dir); }
		const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
		Object.assign(env, isolated, { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(temp, "gitconfig") });
		await exec("git", ["init", "--quiet"], { cwd: root, env });
		await exec("git", ["add", "index.html", "package.json"], { cwd: root, env });
		const options = { binary: "", cacheRoot: isolated.IMPECCABLE_HOME, env };
		const resolved = await resolveEngine(options);
		expect(resolved.trustedOverride).toBe(false);
		const digest = sha256(await fs.readFile(resolved.binary));
		expect(digest).toBe(parseChecksums(await fs.readFile(getChecksumsPath(), "utf8"), ENGINE_VERSION).get(resolved.asset!));
		const native = async (argv: string[]) => {
			const result = await runEngine({ ...options, argv, cwd: root });
			expect(result, result.stderr).toMatchObject({ ok: true, stdoutTruncated: false, trustedOverride: false });
			return JSON.parse(result.stdout);
		};
		const published: unknown[] = [];
		const make = () => { const owner = new LiveOwner("real-native-session", (live) => { if (live.phase === "pending") published.push(live.view()); }, options); owners.push(owner); return owner; };
		let owner = make(); owner.start(root, ["--allow-missing-context"], false); await phase(owner, "polling");
		const firstHelper = JSON.parse(await fs.readFile(path.join(root, ".impeccable/live/server.json"), "utf8"));
		const post = async (event: unknown) => {
			const info = JSON.parse(await fs.readFile(path.join(root, ".impeccable/live/server.json"), "utf8"));
			const response = await fetch(`http://127.0.0.1:${info.port}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: info.token, ...event as object }) });
			const body = await response.json(); expect(response.ok, JSON.stringify(body)).toBe(true); return body;
		};
		await post(generateEvent); await phase(owner, "pending");
		expect(owner.pending!.event).toMatchObject(generateEvent);
		await owner.pause("native recovery smoke"); const saved = owner.saved()!;
		expect(alive(firstHelper.pid)).toBe(false);
		expect((await fetch(appUrl)).ok).toBe(true);
		const before = await native(["live-resume", "--id", generateEvent.id, "--target", root]);
		expect(before.snapshot.pendingEvent.type).toBe("generate");
		owner = make(); await owner.restore(saved); owner.resume(); await phase(owner, "pending");
		const scaffold = await native(["live-wrap", "--id", generateEvent.id, "--count", "1", "--element-id", "hero", "--tag", "h1", "--text", "Original", "--target", root]);
		expect(scaffold.file).toBeTruthy();
		let wrapped = await fs.readFile(path.join(root, "index.html"), "utf8");
		expect(wrapped).toContain("Variants: insert below this line");
		wrapped = wrapped.replace("<!-- Variants: insert below this line -->", '<!-- Variants: insert below this line -->\n<div data-impeccable-variant="1"><h1 id="hero">Verified variant</h1></div>');
		await fs.writeFile(path.join(root, "index.html"), wrapped);
		const p = owner.pending!;
		await owner.reply({ id: p.id, eventToken: p.token, status: "done", file: "index.html" });
		expect(owner.result).toMatchObject({ ok: true, id: p.id, status: "done", file: "index.html" });
		const after = await native(["live-resume", "--id", p.id, "--target", root]);
		expect(after.snapshot.pendingEvent).toBeNull();
		expect(after.snapshot.sourceFile).toBe("index.html");
		await post({ type: "accept", id: p.id, variantId: "1", pageUrl: "/" }); await phase(owner, "pending");
		const accepted = owner.pending!; const ack = accepted.event._completionAck as Record<string, unknown>;
		expect(ack.ok).toBe(true);
		const acceptRecovery = await native(["live-resume", "--id", p.id, "--target", root]);
		process.stdout.write(`Native accept schema: ${JSON.stringify({ ack, result: accepted.event._acceptResult, recovery: acceptRecovery })}\n`);
		expect(await fs.readFile(path.join(root, "index.html"), "utf8")).toContain("Verified variant");
		if (ack.requiresComplete === true) {
			await fs.writeFile(path.join(root, "index.html"), html.replace("Original", "Verified variant"));
			await owner.reply({ id: accepted.id, eventToken: accepted.token, status: "complete", message: "Verified semantic HTML and removed all native temporary markers" });
		} else await owner.reply({ id: accepted.id, eventToken: accepted.token, status: "verified", message: "Verified persisted selected HTML" });
		const terminal = await native(["live-resume", "--id", p.id, "--target", root]);
		expect(terminal.active).toBe(false);
		const journal = (await fs.readFile(path.join(root, `.impeccable/live/sessions/${p.id}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(journal.some((row) => row.id === p.id && row.type === "complete")).toBe(true);
		expect((await native(["live-status", "--target", root])).activeSessions).toEqual([]);
		const helper = JSON.parse(await fs.readFile(path.join(root, ".impeccable/live/server.json"), "utf8"));
		await owner.pause("smoke stop", true); expect(alive(helper.pid)).toBe(false);
		expect((await fetch(appUrl)).ok).toBe(true);
		expect(published.length).toBeGreaterThanOrEqual(3);

		// Exercise the registered Pi event bridge and real model-facing reply tool on the same verified binary.
		// The faux provider has no personal credentials and makes no network/model requests.
		for (const key of Object.keys(process.env)) if (!["PATH", "SystemRoot", "TMPDIR", "TMP", "TEMP", ...Object.keys(isolated)].includes(key)) vi.stubEnv(key, undefined);
		runtime = await liveSession(root);
		let piAck: unknown;
		let piCompletionAck: unknown;
		const packet = (context: { messages: unknown[] }) => {
			const contents = context.messages.map((m) => {
				const content = (m as { content: unknown }).content;
				return typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p.text ?? "").join("\n") : "";
			});
			const content = contents.findLast((s) => s.includes("Impeccable native live event."))!;
			return JSON.parse(content.slice(content.indexOf("\n") + 1)).pending;
		};
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "start", argv: ["--allow-missing-context"] })]),
			fauxAssistantMessage("Waiting for native input"),
			async (context) => {
				const pending = packet(context);
				await native(["live-wrap", "--id", pending.id, "--count", "1", "--element-id", "hero", "--tag", "h1", "--text", "Verified variant", "--target", root]);
				const source = await fs.readFile(path.join(root, "index.html"), "utf8");
				await fs.writeFile(path.join(root, "index.html"), source.replace("<!-- Variants: insert below this line -->", '<!-- Variants: insert below this line -->\n<style>@scope ([data-impeccable-variant="1"]) { :scope > h1 { color: rgb(1, 2, 3); } }</style>\n<div data-impeccable-variant="1"><h1 id="hero">Pi native variant</h1></div>'));
				return fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "reply", id: pending.id, eventToken: pending.eventToken, status: "done", file: "index.html" })]);
			},
			(context) => {
				const result = context.messages.findLast((m) => m.role === "toolResult")!;
				piAck = result.content;
				return fauxAssistantMessage("Pi native publication acknowledged");
			},
			async (context) => {
				const pending = packet(context);
				piCompletionAck = pending.event._completionAck;
				expect(pending.event._completionAck.ok).toBe(true);
				expect(await fs.readFile(path.join(root, "index.html"), "utf8")).toContain("Pi native variant");
				if (pending.event._completionAck.requiresComplete) await fs.writeFile(path.join(root, "index.html"), html.replace("Original", "Pi native variant"));
				return fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "reply", id: pending.id, eventToken: pending.eventToken, status: pending.event._completionAck.requiresComplete ? "complete" : "verified", message: "Verified selected source and completed semantic source cleanup" })]);
			},
			fauxAssistantMessage("Pi native acceptance verified"),
		]);
		await runtime.session.prompt("Start native live smoke"); await expect.poll(() => runtime!.saved()?.phase).toBe("polling");
		await post({ ...generateEvent, id: "bc23de45", element: { ...generateEvent.element, outerHTML: '<h1 id="hero">Verified variant</h1>' } });
		await expect.poll(() => piAck, { timeout: 12_000 }).toBeDefined();
		await expect.poll(() => runtime!.session.isStreaming).toBe(false);
		expect(JSON.stringify(piAck)).toContain('done');
		await post({ type: "accept", id: "bc23de45", variantId: "1", pageUrl: "/" });
		await expect.poll(() => runtime!.faux.state.callCount, { timeout: 12_000 }).toBe(6);
		await expect.poll(() => runtime!.session.isStreaming).toBe(false);
		expect(runtime.errors).toEqual([]);
		const piResults = runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "impeccable_live" ? [entry.message] : []);
		expect(piResults).toHaveLength(3);
		expect(piResults.every((result) => !result.isError)).toBe(true);
		expect(piResults.at(-1)?.details).toMatchObject({ phase: "polling" });
		expect((await native(["live-status", "--target", root])).activeSessions).toEqual([]);
		const piHelper = JSON.parse(await fs.readFile(path.join(root, ".impeccable/live/server.json"), "utf8"));
		await runtime.cleanup(); runtime = undefined;
		expect(alive(piHelper.pid)).toBe(false); expect((await fetch(appUrl)).ok).toBe(true);
		process.stdout.write(`Native live evidence: ${JSON.stringify({ version: ENGINE_VERSION, asset: resolved.asset, sha256: digest, publicationAck: { id: p.id, status: "done", file: "index.html" }, completionAck: ack, phase: "completed (native journal complete)", recoveryWithoutGo: true, piFauxToolAck: true, piCompletionAck, ownedHelperTerminated: true, appSurvived: true })}\n`);
	} finally {
		await runtime?.cleanup();
		await Promise.all(owners.map((owner) => owner.pause("smoke cleanup", true)));
		await new Promise<void>((resolve) => app.close(() => resolve()));
		vi.unstubAllEnvs(); await fs.rm(temp, { recursive: true, force: true });
	}
});
