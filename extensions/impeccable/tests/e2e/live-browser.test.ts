import * as fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { liveSession } from "../support/live-session.ts";
import { LIVE_MESSAGE } from "../../src/live.ts";
import { sha256 } from "../../src/engine.ts";
import * as engine from "../../src/engine.ts";
import { foundations, alive } from "./foundations.ts";
import { project } from "./detector-phase.ts";

let f: Awaited<ReturnType<typeof foundations>>;
beforeAll(async () => { f = await foundations(); });
afterAll(async () => { await f?.cleanup(); }, 30_000);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)]);
const packet = (context: { messages: readonly unknown[] }) => {
	const contents = context.messages.map((m) => {
		const content = (m as { content: unknown }).content;
		return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("\n") : "";
	});
	const content = contents.findLast((s) => s.includes("Impeccable native live event."));
	if (!content) throw new Error("Missing genuine Pi live event");
	return JSON.parse(content.slice(content.indexOf("\n") + 1)).pending;
};

it("recovers a browser Go in the exact Pi session, publishes two native-tool variants and accepts the visible choice", async () => {
	const root = await project(f, "live-project");
	const sourcePath = path.join(root, "page.html");
	const initial = '<!doctype html>\n<html><head><title>SIMULATED library</title></head><body style="font-family:Georgia;padding:64px;background:#faf8f1">\n<h1 id="hero">Original library hours</h1>\n<p>Disposable browser transaction fixture. SIMULATED model content.</p>\n</body></html>\n';
	await fs.writeFile(sourcePath, initial);
	await fs.mkdir(path.join(root, ".impeccable/live"), { recursive: true });
	await fs.writeFile(path.join(root, ".impeccable/live/config.json"), JSON.stringify({ files: ["page.html"], insertBefore: "</body>", commentSyntax: "html", cspChecked: true }));
	// This independent server precedes the owner and serves native-injected source without HMR.
	const app = createServer(async (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(await fs.readFile(sourcePath)); });
	await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
	const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
	const page = await f.browser.newPage();
	// Observe actual children without substituting native execution or transport.
	const children: { argv: string[]; process: ReturnType<typeof engine.spawnEngine> }[] = [];
	const spawn = engine.spawnEngine;
	const observer = vi.spyOn(engine, "spawnEngine").mockImplementation((resolved, argv, options) => {
		const child = spawn(resolved, argv, options); children.push({ argv: [...argv], process: child }); return child;
	});
	const runtime = await liveSession(root, undefined, undefined, true, f.env.PI_CODING_AGENT_DIR!);
	const native = async (argv: string[]) => JSON.parse(await f.native(root, [...argv, "--target", root]));
	const helper = async () => JSON.parse(await fs.readFile(path.join(root, ".impeccable/live/server.json"), "utf8"));
	const results = () => runtime.session.sessionManager.getBranch().flatMap((e) => e.type === "message" && e.message.role === "toolResult" ? [e.message] : []);
	const events: unknown[] = [];
	const consoleMessages: string[] = [];
	const sourceResponses: { url: string; status: number }[] = [];
	page.on("response", (response) => { if (new URL(response.url()).pathname === "/source") sourceResponses.push({ url: response.url(), status: response.status() }); });
	page.on("console", (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`));
	page.on("pageerror", (error) => consoleMessages.push(`pageerror: ${error}`));
	let closed = false;
	try {
		runtime.faux.setResponses([
			call("impeccable_live", { action: "generate", argv: ["--selector", "#hero", "--action", "bolder", "--count", "2", "--dev-url", appUrl, "--wait-for-browser", "60000"] }),
			fauxAssistantMessage("Native Go is running in the background."),
			(context) => { const pending = packet(context); events.push(pending); expect(pending.event.type).toBe("generate"); return fauxAssistantMessage("Interrupt before source work; explicitly resume this pending event."); },
		]);
		await runtime.session.prompt("Start the disposable native browser generation.");
		expect(results()[0].details).toMatchObject({ phase: "starting" });
		await expect.poll(async () => (await fs.readFile(sourcePath, "utf8")).includes("/live.js"), { timeout: 20_000 }).toBe(true);
		const firstHelper = await helper();
		await page.goto(appUrl);
		await expect.poll(() => runtime.saved()?.phase, { timeout: 75_000 }).toBe("paused");
		const saved = runtime.saved()!;
		expect(saved.pending).toBeDefined();
		const first = events[0] as ReturnType<typeof packet>;
		expect(first.event).toMatchObject({ type: "generate", count: 2, action: "bolder" });
		const originalEvent = JSON.parse(await fs.readFile(saved.pending!.file, "utf8"));
		expect(originalEvent.element.outerHTML).toContain('id="hero"');
		await expect.poll(() => alive(firstHelper.pid)).toBe(false);
		expect(children.every((c) => !c.process.child.pid || !alive(c.process.child.pid))).toBe(true);
		expect((await fetch(appUrl)).ok).toBe(true); expect(f.browser.browser()!.isConnected()).toBe(true);
		const recoveryBefore = await native(["live-resume", "--id", first.id]);
		expect(recoveryBefore.snapshot.pendingEvent.type).toBe("generate");
		const sessionId = runtime.session.sessionManager.getSessionId();
		await runtime.session.reload();
		expect(runtime.session.sessionManager.getSessionId()).toBe(sessionId);
		const stale = await runtime.session.extensionRunner.emitContext([{ role: "custom", customType: LIVE_MESSAGE, content: "STALE-BROWSER-EVENT", display: true, timestamp: Date.now(), details: { sessionId, activation: "expired", eventToken: first.eventToken } }]);
		expect(JSON.stringify(stale)).not.toContain("STALE-BROWSER-EVENT");
		let pending: ReturnType<typeof packet>;
		let scaffold: string;
		const marker = "<!-- Variants: insert below this line -->";
		const variantMarkup = '\n<div data-impeccable-variant="1"><h1 id="hero" style="color:#164b38;font-size:48px">SIMULATED emerald library</h1></div>\n<div data-impeccable-variant="2"><h1 id="hero" style="color:#782b27;font-size:56px">SIMULATED vermilion library</h1></div>';
		runtime.faux.setResponses([
			(context) => { expect(JSON.stringify(context.messages)).not.toContain("Impeccable native live event."); return call("impeccable_live", { action: "resume" }); },
			fauxAssistantMessage("Resume the exact pending Go without creating another request."),
			async (context) => {
				pending = packet(context); events.push(pending);
				expect(pending.id).toBe(first.id); expect(pending.eventToken).not.toBe(first.eventToken);
				const currentOwner = (results().findLast((r) => r.toolName === "impeccable_live")!.details as { owner: string }).owner;
				const staleToken = await runtime.session.extensionRunner.emitContext([{ role: "custom", customType: LIVE_MESSAGE, content: "STALE-ROTATED-TOKEN", display: true, timestamp: Date.now(), details: { sessionId, activation: currentOwner, eventToken: first.eventToken } }]);
				expect(JSON.stringify(staleToken)).not.toContain("STALE-ROTATED-TOKEN");
				// Reconnect before editing: publication must mount via the upstream /source fallback.
				const connected = page.waitForEvent("console", { predicate: (msg) => msg.text().includes("Live mode connected."), timeout: 10_000 });
				await page.reload(); await connected;
				return call("read", { path: pending.event.payloadPath ?? "page.html" });
			},
			async () => {
				// Inspect real preflight scaffold; wrap only when native did not already do so.
				scaffold = await fs.readFile(sourcePath, "utf8");
				f.receipt.livePreflight = { event: originalEvent, source: scaffold }; await f.save();
				return originalEvent.scaffold?.wrapperBlock || scaffold.includes(marker) ? call("read", { path: "page.html" }) : call("impeccable_run", { argv: ["live-wrap", "--id", pending.id, "--count", "2", "--element-id", "hero", "--tag", "h1", "--text", "Original library hours"] });
			},
			async () => {
				scaffold = await fs.readFile(sourcePath, "utf8");
				const block = originalEvent.scaffold?.sourceWritten === false ? originalEvent.scaffold.wrapperBlock as string : undefined;
				expect((block ?? scaffold).split(marker)).toHaveLength(2);
				return call("edit", { path: "page.html", edits: [{ oldText: block ? originalEvent.element.outerHTML : marker, newText: block ? block.replace(marker, marker + variantMarkup) : marker + variantMarkup }] });
			},
			() => call("impeccable_live", { action: "reply", id: pending.id, eventToken: pending.eventToken, status: "done", file: "page.html" }),
			fauxAssistantMessage("Two SIMULATED variants published with genuine native acknowledgement."),
			async (context) => {
				const accepted = packet(context); events.push(accepted);
				expect(accepted.event.type, JSON.stringify(accepted)).toBe("accept");
				expect(accepted.event._completionAck).toMatchObject({ ok: true, type: "complete" });
				expect(accepted.event._completionAck.requiresComplete).not.toBe(true);
				return call("read", { path: "page.html" });
			},
			async () => {
				const accepted = events.at(-1) as ReturnType<typeof packet>;
				const chosen = await fs.readFile(sourcePath, "utf8");
				expect(chosen).toContain("SIMULATED vermilion library");
				expect(chosen).not.toContain("SIMULATED emerald library");
				expect(chosen).not.toMatch(/data-impeccable-variant|impeccable-variants-start|carbonize/);
				return call("impeccable_live", { action: "reply", id: accepted.id, eventToken: accepted.eventToken, status: "verified", message: `Read persisted page.html: chosen vermilion content; no temporary variants/carbonize markers. SHA256 ${sha256(Buffer.from(chosen))}` });
			},
			fauxAssistantMessage("Native terminal acceptance and persisted source verified."),
		]);
		await runtime.session.prompt("Explicitly resume and publish the saved native event.");
		await expect.poll(() => results().filter((r) => r.toolName === "impeccable_live" && JSON.stringify(r.details).includes('"status":"done"')).length, { timeout: 30_000 }).toBe(1);
		await expect.poll(() => runtime.session.isStreaming).toBe(false);
		await page.locator("#impeccable-live-variant-counter").waitFor({ state: "visible", timeout: 40_000 });
		expect(sourceResponses.some((response) => response.status === 200), JSON.stringify(sourceResponses)).toBe(true);
		expect(await page.locator('[data-impeccable-variant="1"] #hero').isVisible()).toBe(true);
		await page.screenshot({ path: path.join(f.artifacts, "live-variant-1.png") });
		await page.locator("#impeccable-live-variant-next").click();
		await expect.poll(() => page.locator('[data-impeccable-variant="2"] #hero').isVisible()).toBe(true);
		expect(await page.locator("#impeccable-live-variant-counter").textContent()).toContain("2");
		await page.screenshot({ path: path.join(f.artifacts, "live-variant-2.png") });
		await page.getByRole("button", { name: "✓ Accept", exact: true }).click();
		await expect.poll(() => events.length, { timeout: 20_000 }).toBe(3);
		await expect.poll(() => runtime.saved()?.phase, { timeout: 20_000 }).toBe("polling");
		await expect.poll(() => runtime.session.isStreaming).toBe(false);
		expect(runtime.errors).toEqual([]); expect(results().every((r) => !r.isError), JSON.stringify(results())).toBe(true);
		expect(runtime.faux.getPendingResponseCount()).toBe(0);
		const journalPath = path.join(root, `.impeccable/live/sessions/${first.id}.jsonl`);
		const journal = await fs.readFile(journalPath, "utf8");
		await fs.writeFile(path.join(f.artifacts, "live-journal.jsonl"), journal);
		const rows = journal.trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.filter((row) => row.type === "generate" && !row.event.scaffoldAttempted)).toHaveLength(1);
		expect(new Set(rows.filter((row) => row.type === "generate").map((row) => row.event.clientSentAt)).size).toBe(1);
		expect(rows.filter((row) => row.type === "agent_done")).toHaveLength(1);
		expect(rows.filter((row) => row.type === "accept" && row.event.variantId === "2")).toHaveLength(1);
		expect(results().filter((r) => r.toolName === "edit")).toHaveLength(1);
		expect(rows.filter((row) => row.type === "complete")).toHaveLength(1);
		expect((await native(["live-resume", "--id", first.id])).active).toBe(false);
		expect((await native(["live-status"])).activeSessions).toEqual([]);
		const finalHelper = await helper();
		expect(finalHelper.token).not.toBe(firstHelper.token);
		expect((await fs.readFile(sourcePath, "utf8"))).toContain(`token=${finalHelper.token}`);
		// A second genuine browser request exercises discard without changing the accepted source.
		let discardPending: ReturnType<typeof packet>;
		let discardAck: ReturnType<typeof packet>;
		const acceptedSource = await fs.readFile(sourcePath, "utf8");
		runtime.faux.setResponses([
			call("impeccable_live", { action: "generate", argv: ["--selector", "#hero", "--action", "bolder", "--count", "2", "--dev-url", appUrl, "--wait-for-browser", "60000"] }),
			fauxAssistantMessage("Second native browser Go; discard this exploration."),
			(context) => { discardPending = packet(context); events.push(discardPending); expect(discardPending.event.type).toBe("generate"); return call("read", { path: "page.html" }); },
			() => {
				const event = discardPending.event;
				expect(event.scaffold.sourceWritten).toBe(false);
				return call("edit", { path: "page.html", edits: [{ oldText: event.element.outerHTML, newText: event.scaffold.wrapperBlock.replace(marker, marker + variantMarkup.replaceAll("SIMULATED", "SIMULATED DISCARD")) }] });
			},
			() => call("impeccable_live", { action: "reply", id: discardPending.id, eventToken: discardPending.eventToken, status: "done", file: "page.html" }),
			fauxAssistantMessage("Discard candidates published."),
			(context) => { discardAck = packet(context); events.push(discardAck); expect(discardAck.event.type).toBe("discard"); expect(discardAck.event._completionAck).toMatchObject({ ok: true, type: "discarded" }); return call("read", { path: "page.html" }); },
			async () => {
				const source = await fs.readFile(sourcePath, "utf8");
				expect(source).toContain("SIMULATED vermilion library"); expect(source).not.toMatch(/SIMULATED DISCARD|data-impeccable-variant|carbonize/);
				return call("impeccable_live", { action: "reply", id: discardAck.id, eventToken: discardAck.eventToken, status: "verified", message: `Read page.html after native discard; accepted vermilion retained, discarded variants removed. SHA256 ${sha256(Buffer.from(source))}` });
			},
			fauxAssistantMessage("Genuine native discard verified separately from transport acknowledgement."),
		]);
		await runtime.session.prompt("Generate a second disposable exploration, then discard through the overlay.");
		await expect.poll(async () => {
			const info = await helper().catch(() => undefined);
			return info && info.token !== finalHelper.token && (await fs.readFile(sourcePath, "utf8")).includes(`token=${info.token}`);
		}, { timeout: 20_000 }).toBe(true);
		const discardHelper = await helper();
		await page.reload();
		await expect.poll(() => results().filter((r) => r.toolName === "edit").length, { timeout: 20_000 }).toBe(2);
		await page.locator("#impeccable-live-variant-counter").waitFor({ state: "visible", timeout: 20_000 });
		await page.screenshot({ path: path.join(f.artifacts, "live-discard.png") });
		await page.getByTitle("Discard all variants", { exact: true }).click();
		await expect.poll(() => events.length, { timeout: 20_000 }).toBe(5);
		await expect.poll(() => runtime.saved()?.phase).toBe("polling");
		await expect.poll(() => runtime.session.isStreaming).toBe(false);
		expect(runtime.faux.getPendingResponseCount()).toBe(0);
		expect(results().every((r) => !r.isError), JSON.stringify(results())).toBe(true);
		const discardJournal = await fs.readFile(path.join(root, `.impeccable/live/sessions/${discardPending!.id}.jsonl`), "utf8");
		const discardRows = discardJournal.trim().split("\n").map((line) => JSON.parse(line));
		expect(discardRows.filter((row) => row.type === "discarded")).toHaveLength(1);
		expect(discardRows.filter((row) => row.type === "agent_done")).toHaveLength(1);
		expect((await native(["live-status"])).activeSessions).toEqual([]);
		// Ignore only the refreshed authentication tag when comparing persisted semantic source.
		const withoutToken = (text: string) => text.replace(/token=[^"&]+/g, "token=REDACTED");
		expect(withoutToken(await fs.readFile(sourcePath, "utf8"))).toBe(withoutToken(acceptedSource));
		await fs.writeFile(path.join(f.artifacts, "live-discard-journal.jsonl"), discardJournal);
		f.receipt.liveDiscard = { pending: discardPending!, acknowledgement: discardAck!, journalSha256: sha256(Buffer.from(discardJournal)), helper: discardHelper };
		runtime.faux.setResponses([call("impeccable_live", { action: "stop" }), fauxAssistantMessage("Owned helper stopped; independent app and browser remain available.")]);
		await runtime.session.prompt("Stop the live owner.");
		expect(alive(discardHelper.pid)).toBe(false); expect(alive(finalHelper.pid)).toBe(false); expect(runtime.saved()?.phase).toBe("stopped");
		expect((await fetch(appUrl)).ok).toBe(true); expect(f.browser.browser()!.isConnected()).toBe(true);
		await runtime.cleanup(); closed = true;
		expect(runtime.session.isStreaming).toBe(false); expect((await fetch(appUrl)).ok).toBe(true);
		expect(children.every((c) => !c.process.child.pid || !alive(c.process.child.pid))).toBe(true);
		expect(children.filter((c) => c.argv[0] === "live-generate")).toHaveLength(2);
		expect(children.filter((c) => c.argv.includes("--reply"))).toHaveLength(2);
		expect(children.filter((c) => c.argv[0] === "live-complete")).toHaveLength(0);
		expect(runtime.faux.state.callCount).toBe(24);
		expect(results()).toHaveLength(15);
		expect(results().filter((r) => r.toolName === "edit")).toHaveLength(2);
		expect(sourceResponses.filter((response) => response.status === 200).length).toBeGreaterThanOrEqual(2);
		expect(runtime.saved()?.pending).toBeUndefined();
		// Fixture-owned helper: a new Pi owner may reuse it but must leave it running.
		const resolved = await engine.resolveEngine({ binary: "", cacheRoot: f.env.IMPECCABLE_HOME! });
		const borrowed = spawn(resolved, ["live-server", "--target", root], { cwd: root, env: f.env });
		let borrower: Awaited<ReturnType<typeof liveSession>> | undefined;
		try {
			await expect.poll(async () => (await helper().catch(() => undefined))?.pid).toBe(borrowed.child.pid);
			borrower = await liveSession(root, undefined, undefined, true, f.env.PI_CODING_AGENT_DIR!);
			borrower.faux.setResponses([call("impeccable_live", { action: "start", argv: ["--allow-missing-context", "--dev-url", "--no-live-bar"] }), fauxAssistantMessage("Reusing fixture-owned helper.")]);
			await borrower.session.prompt("Start using the existing native helper.");
			await expect.poll(() => borrower!.saved()?.phase).toBe("polling");
			borrower.faux.setResponses([call("impeccable_live", { action: "stop" }), fauxAssistantMessage("Stopped only this owner's poller.")]);
			await borrower.session.prompt("Stop the borrowing owner.");
			expect(borrower.errors).toEqual([]);
			expect(borrower.faux.getPendingResponseCount()).toBe(0);
			expect(borrower.faux.state.callCount).toBe(4);
			expect(alive(borrowed.child.pid!)).toBe(true);
			await borrower.cleanup(); borrower = undefined;
			expect(alive(borrowed.child.pid!)).toBe(true);
			expect((await fetch(appUrl)).ok).toBe(true); expect(f.browser.browser()!.isConnected()).toBe(true);
			f.receipt.liveReusedHelper = { pid: borrowed.child.pid, survivedStopAndShutdown: true };
		} finally { await borrower?.cleanup(); borrowed.cancel(); await borrowed.exited; }
		expect(alive(borrowed.child.pid!)).toBe(false);
		expect(children.every((c) => !c.process.child.pid || !alive(c.process.child.pid))).toBe(true);
		await fs.writeFile(path.join(f.artifacts, "live-journal.jsonl"), journal);
		await fs.writeFile(path.join(f.artifacts, "live-chosen.html"), await fs.readFile(sourcePath));
		f.receipt.live = { events, recoveryBefore, recoveryWithoutAnotherGo: true, staleDeliveryRejected: true, firstHelper, finalHelper, tools: results().map((r) => ({ toolName: r.toolName, isError: r.isError, details: r.details })), fauxCalls: runtime.faux.state.callCount, journalSha256: sha256(Buffer.from(journal)), sourceSha256: sha256(await fs.readFile(sourcePath)), ownedHelpersExited: true, children: children.map((c) => ({ argv: c.argv, pid: c.process.child.pid, exitCode: c.process.child.exitCode, signalCode: c.process.child.signalCode })), appSurvived: true, browserSurvived: true, sourceResponses, consoleMessages };
		await f.save();
	} catch (error) {
		f.receipt.liveFailure = { error: String(error), saved: runtime.saved(), source: await fs.readFile(sourcePath, "utf8"), events, tools: results(), sourceResponses, consoleMessages }; await f.save();
		await page.screenshot({ path: path.join(f.artifacts, "live-failure.png") }).catch(() => {});
		throw error;
	} finally {
		if (!closed) await runtime.cleanup();
		observer.mockRestore();
		await page.close(); await new Promise<void>((resolve) => app.close(() => resolve()));
		expect(page.isClosed()).toBe(true); expect(app.listening).toBe(false);
		f.receipt.liveFixtureCleanup = { pageClosed: page.isClosed(), appClosed: !app.listening, piStreaming: runtime.session.isStreaming };
		await f.save();
	}
}, 180_000);
