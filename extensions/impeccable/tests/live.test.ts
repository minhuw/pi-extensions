import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { validateLiveEvent } from "../src/live.ts";
import { spawnEngine, resolveEngine } from "../src/engine.ts";
import { runOperation } from "../src/operations.ts";
import { generateEvent, liveFixture, phase, alive } from "./support/live-fixture.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";
isolateEngineEnvironment();

it("starts promptly, delivers one leased event, validates native ack, and releases only owned processes", async () => {
	const h = await liveFixture(); const live = h.owner();
	try {
		expect(live.start(h.root, [], false).phase).toBe("starting");
		await phase(live, "polling");
		await h.write("event.json", generateEvent); await phase(live, "pending");
		const pending = live.pending!;
		await expect(live.reply({ id: "bad", eventToken: pending.token, status: "done", file: "index.html" })).rejects.toThrow("Wrong/stale");
		expect(live.phase).toBe("pending");
		await live.reply({ id: pending.id, eventToken: pending.token, status: "done", file: "index.html" });
		expect(live.result).toMatchObject({ ok: true, id: pending.id, status: "done", file: "index.html" });
		await expect(live.reply({ id: pending.id, eventToken: pending.token, status: "done" })).rejects.toThrow("Wrong/stale");
		await live.pause("stop", true);
		expect((await h.calls()).every((call) => !alive(call.pid))).toBe(true);
		const replies = (await h.calls()).filter((call) => call.argv.includes("--reply"));
		expect(replies).toHaveLength(1);
	} finally { await h.cleanup(); }
});

it("generate exclusively owns its returned event without starting a competing poller", async () => {
	const h = await liveFixture(); const live = h.owner();
	try {
		live.start(h.root, ["#hero"], true);
		await expect.poll(async () => (await h.calls()).some((c) => c.argv[0] === "live-generate")).toBe(true);
		expect((await h.calls()).some((c) => c.argv[0] === "live-poll")).toBe(false);
		await h.write("go.json", generateEvent); await phase(live, "pending");
		expect(live.pending?.event).toMatchObject(generateEvent);
		expect((await h.calls()).filter((c) => c.argv[0] === "live-poll")).toHaveLength(0);
		const p = live.pending!;
		await live.reply({ id: p.id, eventToken: p.token, status: "done", file: "index.html" });
		await h.write("event.json", generateEvent);
		await phase(live, "paused"); expect(live.message).toContain("Duplicate");
	} finally { await h.cleanup(); }
});

it.each([
	{ type: "steer", id: "ab12cd34", message: "Use the existing accent" },
	{ type: "variant_mount_failed", id: "ab12cd34", variant: 1, url: "/v1", error: "invalid module" },
	{ type: "manual_edit_apply", id: "ab12cd34", batch: { entries: [{ id: "text-one" }] }, pageUrl: "/", deadlineMs: 120_000 },
	{ type: "prefetch", pageUrl: "/" },
	{ type: "accept", id: "ab12cd34", variantId: "1", _acceptResult: { handled: true }, _completionAck: { ok: true, type: "complete" } },
	{ type: "discard", id: "ab12cd34", _acceptResult: { handled: true }, _completionAck: { ok: true, type: "discarded" } },
	{ type: "accept", id: "ab12cd34", variantId: "1", _acceptResult: { handled: true, carbonize: true }, _completionAck: { ok: true, type: "agent_done", requiresComplete: true } },
	{ type: "discard", id: "ab12cd34", _acceptResult: { handled: true }, _completionAck: { ok: false, error: "helper disconnected before acknowledgement" } },
	{ type: "accept", id: "ab12cd34", variantId: "1", _acceptResult: { handled: false, mode: "fallback" }, _completionAck: { ok: true, type: "agent_done" } },
	{ type: "accept", id: "ab12cd34", variantId: "1", _acceptResult: { handled: true }, _completionAck: { ok: false, error: "transport interrupted" } },
	{ type: "carbonize_cleanup", id: "ab12cd35", sessionId: "ab12cd34", file: "index.html", variantId: "1" },
])("retains native $type handling and parent reply ownership", async (event) => {
	const h = await liveFixture(); const live = h.owner();
	try {
		live.start(h.root, [], false); await phase(live, "polling");
		await h.write("event.json", event); await phase(live, "pending"); const p = live.pending!;
		const status = event.type === "prefetch" ? "read" : event.type === "steer" ? "steer_done" : ["accept", "discard"].includes(event.type) && event._completionAck?.ok === true && ["complete", "discarded"].includes(String(event._completionAck?.type)) ? "verified" : ["accept", "discard", "carbonize_cleanup"].includes(event.type) ? "complete" : "done";
		const data = { status: "partial", appliedEntryIds: ["text-one"], failed: [{ id: "text-two", reason: "ambiguous" }], files: ["index.html"], notes: ["Exact source evidence"] };
		await live.reply({ id: p.id, eventToken: p.token, status, file: event.type === "variant_mount_failed" ? "index.html" : undefined, message: "Verified source artifacts and selected behavior", data: event.type === "manual_edit_apply" ? data : undefined });
		expect(live.phase).toBe("polling");
		const calls = await h.calls(); const replies = calls.filter((call) => call.argv.includes("--reply"));
		if (["prefetch", "accept", "discard", "carbonize_cleanup"].includes(event.type)) expect(replies).toHaveLength(0);
		else expect(replies).toHaveLength(1);
		if (event.type === "manual_edit_apply") expect(JSON.parse(replies[0]!.argv[replies[0]!.argv.indexOf("--data") + 1]!)).toEqual(data);
	} finally { await h.cleanup(); }
});

it.each([
	{ replyRefused: true }, { ack: { id: "ffffffff" } }, { ack: { status: "error" } }, { ack: { file: "elsewhere.html" } }, { leavePending: true },
])("pauses on a native refusal, mismatched ack or pending settlement: %j", async (control) => {
	const h = await liveFixture(); const live = h.owner();
	try {
		live.start(h.root, [], false); await phase(live, "polling"); await h.write("event.json", generateEvent); await phase(live, "pending");
		await h.write("control.json", control); const p = { ...live.pending! };
		await expect(live.reply({ id: p.id, eventToken: p.token, status: "done", file: "index.html" })).rejects.toThrow();
		expect(live.phase).toBe("paused"); expect(live.pending?.token).not.toBe(p.token);
		expect((await h.calls()).filter((c) => c.argv.includes("--reply"))).toHaveLength(1);
	} finally { await h.cleanup(); }
});

it.each(["{", JSON.stringify({ type: "new_unknown_event" }), JSON.stringify({ ok: false, error: "blocked" }), JSON.stringify(generateEvent) + " ".repeat(4 * 1024 * 1024)])("reports malformed/unknown/refused/overflow raw output without parsing a truncated model result", async (raw) => {
	const h = await liveFixture(); const live = h.owner();
	try {
		await h.write("control.json", { raw }); live.start(h.root, [], false); await phase(live, "paused");
		expect(live.pending).toBeUndefined(); expect(live.message).toMatch(/Invalid native JSON|Unknown native|business refusal|capture bound/);
	} finally { await h.cleanup(); }
});

it("preserves carbonize work on a native completion business refusal", async () => {
	const h = await liveFixture(); const live = h.owner();
	try {
		live.start(h.root, [], false); await phase(live, "polling");
		await h.write("event.json", { type: "accept", id: generateEvent.id, variantId: "1", _acceptResult: { handled: true, carbonize: true }, _completionAck: { ok: true, type: "agent_done", requiresComplete: true } });
		await phase(live, "pending"); const pending = live.pending!;
		await h.write("control.json", { completeRefused: true });
		await expect(live.reply({ id: pending.id, eventToken: pending.token, status: "complete", message: "Inspected source cleanup" })).rejects.toThrow("business refusal");
		expect(live.phase).toBe("paused"); expect(live.pending?.id).toBe(generateEvent.id);
		expect(live.result).toMatchObject({ ok: false, error: "source_dirty" });
		expect((await h.calls()).filter((c) => c.argv[0] === "live-complete")).toHaveLength(1);
		expect((await h.calls()).filter((c) => c.argv.includes("--reply"))).toHaveLength(0);
	} finally { await h.cleanup(); }
});

it.each(["manual-deadline", "helper-identity", "nonzero-native"] as const)("pauses safely on %s without falsely acknowledging work", async (failure) => {
	const h = await liveFixture(); const live = h.owner();
	try {
		live.start(h.root, [], false); await phase(live, "polling");
		if (failure === "nonzero-native") {
			await h.write("control.json", { raw: JSON.stringify(generateEvent), exitCode: 1 });
			await phase(live, "paused"); expect(live.pending).toBeUndefined();
		} else {
			await h.write("event.json", failure === "manual-deadline" ? { type: "manual_edit_apply", id: generateEvent.id, pageUrl: "/", batch: { entries: [{ id: "one" }] }, deadlineMs: 1 } : generateEvent);
			await phase(live, "pending");
			if (failure === "manual-deadline") await new Promise((resolve) => setTimeout(resolve, 10));
			else { const info = JSON.parse(await readFile(`${h.directory}/server.json`, "utf8")); await h.write("server.json", { ...info, token: "replaced" }); }
			const pending = live.pending!;
			await expect(live.reply({ id: pending.id, eventToken: pending.token, status: "done", file: "index.html", data: { status: "done", appliedEntryIds: ["one"], failed: [], files: ["index.html"], notes: [] } })).rejects.toThrow(failure === "manual-deadline" ? "soft deadline" : "identity changed");
			expect(live.phase).toBe("paused"); expect((await h.calls()).filter((c) => c.argv.includes("--reply"))).toHaveLength(0);
		}
	} finally { await h.cleanup(); }
});

it("rejects a foreign session reply without consuming or stopping the owning session", async () => {
	const h = await liveFixture(); const live = h.owner(); const foreign = h.owner("foreign");
	try {
		live.start(h.root, [], false); await phase(live, "polling"); await h.write("event.json", generateEvent); await phase(live, "pending");
		const pending = live.pending!;
		await expect(foreign.reply({ id: pending.id, eventToken: pending.token, status: "done", file: "index.html" })).rejects.toThrow("owning Pi session");
		expect(live.phase).toBe("pending"); expect((await h.calls()).filter((c) => c.argv.includes("--reply"))).toHaveLength(0);
	} finally { await h.cleanup(); }
});

it("keeps complete large native JSON outside the project and rotates recovery tokens without another Go", async () => {
	const h = await liveFixture(); let live = h.owner();
	try {
		live.start(h.root, [], false); await phase(live, "polling");
		await h.write("event.json", { ...generateEvent, extra: "x".repeat(90_000) }); await phase(live, "pending");
		expect(live.view().pending?.event).toMatchObject({ payloadPath: live.pending!.file });
		expect(live.pending!.file.startsWith(h.root)).toBe(false);
		expect(JSON.parse(await readFile(live.pending!.file, "utf8")).extra).toHaveLength(90_000);
		const old = live.pending!.token; await live.pause("reload"); const saved = live.saved()!;
		const fork = h.owner("fork"); await expect(fork.restore(saved)).rejects.toThrow("session/branch");
		live = h.owner(); await live.restore(saved); live.resume(); await phase(live, "pending");
		expect(live.pending!.token).not.toBe(old);
		await expect(live.reply({ id: live.pending!.id, eventToken: old, status: "done", file: "index.html" })).rejects.toThrow("Wrong/stale");
		const pending = live.pending!; await live.reply({ id: pending.id, eventToken: pending.token, status: "done", file: "index.html" });
	} finally { await h.cleanup(); }
});

it("enforces physical-project contention, preserves reused helper and never holds management queues", async () => {
	const h = await liveFixture(); const first = h.owner(); const second = h.owner("two");
	const resolved = await resolveEngine({ binary: h.binary });
	const helper = spawnEngine(resolved, ["live-server"], { cwd: h.root, env: h.env });
	try {
		await expect.poll(async () => { try { return JSON.parse(await readFile(`${h.directory}/server.json`, "utf8")).pid; } catch { return 0; } }).toBe(helper.child.pid);
		first.start(h.root, [], false); await phase(first, "polling");
		second.start(h.root, [], false); await phase(second, "paused"); expect(second.message).toContain("owned by another");
		await first.pause("switch"); expect(alive(helper.child.pid!)).toBe(true);
		second.start(h.root, [], false); await phase(second, "polling");
		await second.pause("shutdown"); expect(alive(helper.child.pid!)).toBe(true);
	} finally { helper.cancel(); await helper.exited; await h.cleanup(); }
});

it.each(["timeout", "exit"])("releases owned poller/helper on native %s and preserves native files", async (type) => {
	const h = await liveFixture(); const live = h.owner();
	try {
		live.start(h.root, [], false); await phase(live, "polling"); await h.write("event.json", { type }); await phase(live, type === "exit" ? "stopped" : "paused");
		expect((await h.calls()).every((c) => !alive(c.pid))).toBe(true);
		expect(await readFile(`${h.directory}/config.json`, "utf8")).toContain("cspChecked");
	} finally { await h.cleanup(); }
});

it.each(["live", "live-generate", "live-poll", "live-server", "live-complete"])("explicitly hands %s to the session owner without engine execution", async (verb) => {
	const result = await runOperation({ argv: [verb], binary: "/missing" }, { getCommands: () => [] });
	expect(result).toMatchObject({ ok: false, integration: { engineRun: false } });
	expect(result.stderr).toContain("impeccable_live");
});

it("excludes a separate process and permits only proven-dead same-session lease recovery", async () => {
	const h = await liveFixture();
	const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./support/live-contender.ts", import.meta.url)), h.root, h.binary, "same-session"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let helperPid: number | undefined;
	let diagnostic = ""; child.stderr!.on("data", (chunk) => { diagnostic += String(chunk); });
	try {
		const message = await new Promise<{ view: { phase: string }; saved: import("../src/live.ts").LiveSaved }>((resolve, reject) => { child.once("message", (value) => resolve(value as never)); child.once("error", reject); child.once("exit", (code) => reject(new Error(`Contender exited ${code}: ${diagnostic}`))); });
		expect(message.view.phase).toBe("polling");
		helperPid = JSON.parse(await readFile(`${h.directory}/server.json`, "utf8")).pid;
		const blocked = h.owner("another-session"); blocked.start(h.root, [], false); await phase(blocked, "paused"); expect(blocked.message).toContain("owned by another");
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve())); child.send("crash"); await exited;
		const foreign = h.owner("another-session"); foreign.start(h.root, [], false); await phase(foreign, "paused"); expect(foreign.message).toContain("owned by another");
		const recovered = h.owner("same-session"); await recovered.restore(message.saved); recovered.resume(); await phase(recovered, "polling");
		await recovered.pause("stop", true); expect(alive(helperPid!)).toBe(true);
	} finally {
		if (child.exitCode === null) { child.send("stop"); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
		if (helperPid && alive(helperPid)) process.kill(helperPid, "SIGTERM");
		await h.cleanup();
	}
});

it("validates canonical native ids and preserves unknown optional fields", () => {
	expect(validateLiveEvent({ ...generateEvent, provenance: { keep: true } })).toMatchObject({ provenance: { keep: true } });
	expect(() => validateLiveEvent({ ...generateEvent, id: "ab12cd34-extra" })).toThrow("malformed");
});
