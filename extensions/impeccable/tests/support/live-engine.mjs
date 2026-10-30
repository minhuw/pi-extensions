#!/usr/bin/env node
// Executable native-CLI protocol double. No provider, network or installed engine.
import fs from "node:fs";
import path from "node:path";
const root = process.env.IMPECCABLE_LIVE_FIXTURE;
if (!root) throw new Error("fixture root required");
const dir = path.join(root, ".impeccable/live");
const read = (name, fallback = null) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return fallback; } };
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const argv = process.argv.slice(2);
const verb = argv[0];
const control = () => read("control.json", {});
const output = (value) => { process.stdout.write(JSON.stringify(value)); };
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv, pid: process.pid }) + "\n");
const helper = () => {
	const info = read("server.json");
	try { process.kill(info.pid, 0); return info; } catch { return null; }
};
const snapshot = () => read("snapshot.json");
const terminal = (id, type) => {
	fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
	fs.appendFileSync(path.join(dir, "sessions", `${id}.jsonl`), JSON.stringify({ seq: 1, id, type, event: { id, type } }) + "\n");
};
const publish = (event) => { if (event.id) write("snapshot.json", { id: event.sessionId ?? event.id, phase: "generate_requested", pendingEvent: event }); return event; };
if (verb === "live-inject") output({ ok: true, path: path.join(dir, "config.json"), config: read("config.json") });
else if (verb === "live-server") {
	write("server.json", { pid: process.pid, port: 8400, token: "fixture-secret" });
	setInterval(() => {}, 1000);
} else if (verb === "live") {
	write("roots.json", { version: 1, appRoot: root, repoRoot: root, sessionRoot: dir });
	output({ ok: true, projectRoot: root, roots: read("roots.json"), serverPort: helper()?.port, serverToken: helper()?.token, pageFiles: [path.join(root, "index.html")] });
} else if (verb === "live-status") {
	const state = snapshot();
	output({ liveServer: helper() ? { port: helper().port, pendingEvents: state?.pendingEvent ? [state.pendingEvent] : [] } : null, activeSessions: state && !["completed", "discarded"].includes(state.phase) ? [state] : [] });
} else if (verb === "live-resume") output(["completed", "discarded"].includes(snapshot()?.phase) ? { active: false, nextAction: "No active durable live session found." } : { active: true, snapshot: snapshot(), pendingEvent: snapshot()?.pendingEvent ?? null });
else if (verb === "live-complete") {
	if (control().completeRefused) output({ ok: false, error: "source_dirty" });
	else { const state = snapshot(); const discarded = argv.includes("--discarded"); write("snapshot.json", { ...state, phase: discarded ? "discarded" : "completed", pendingEvent: null }); terminal(state.id, discarded ? "discarded" : "complete"); output({ ok: true, id: state.id, phase: discarded ? "discarded" : "completed" }); }
} else if (verb === "live-poll" && argv.includes("--reply")) {
	const i = argv.indexOf("--reply"); const id = argv[i + 1]; const status = argv[i + 2];
	const flags = control();
	if (flags.replyRefused) output({ ok: false, error: "compile failed" });
	else {
		if (!flags.leavePending) write("snapshot.json", { ...snapshot(), pendingEvent: null, phase: "agent_done" });
		const file = argv.includes("--file") ? argv[argv.indexOf("--file") + 1] : undefined;
		output({ ok: true, id, status, ...(file ? { file } : {}), ...flags.ack });
	}
} else if (verb === "live-poll" || verb === "live-generate") {
	const timer = setInterval(() => {
		if (!fs.existsSync(dir)) { clearInterval(timer); return; }
		const flags = control();
		if (flags.raw !== undefined) { clearInterval(timer); process.stdout.write(flags.raw, () => process.exit(flags.exitCode ?? 0)); }
		const event = read(verb === "live-generate" ? "go.json" : "event.json");
		if (!event) return;
		clearInterval(timer);
		fs.unlinkSync(path.join(dir, verb === "live-generate" ? "go.json" : "event.json"));
		publish(event);
		if (["accept", "discard"].includes(event.type) && event._completionAck?.ok === true && ["complete", "discarded"].includes(event._completionAck?.type) && event._completionAck?.requiresComplete !== true) {
			write("snapshot.json", { id: event.id, phase: event.type === "accept" ? "completed" : "discarded", pendingEvent: null });
			terminal(event.id, event.type === "accept" ? "complete" : "discarded");
		}
		output(verb === "live-generate" ? { ok: true, sessionId: event.id, event } : event);
	}, 10);
} else { output({ ok: false, error: `unknown fixture verb ${verb}` }); process.exitCode = 1; }
