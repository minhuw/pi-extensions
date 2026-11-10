import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FakeRelay } from "./support/relay-server.ts";
import { type Harness, Notes, type SessionOptions, setCredentials, setModes, startSession, waitFor, waitOnline, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
beforeEach(async () => { workspace = await Workspace.create(); relay = await new FakeRelay().start(); setCredentials(relay.url); });
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.shutdown();
	await relay.stop();
	await workspace.cleanup();
});

async function online(options: Partial<SessionOptions> = {}) {
	const notes = new Notes();
	const ui = notes.context();
	const publish = vi.spyOn(ui, "setStatus");
	const h = await startSession({ workspace, ui, ...options });
	harnesses.push(h);
	await waitOnline(relay, h.session.sessionId);
	return { h, notes, publish, joined: () => notes.statuses.get("relay-rooms"), role: () => notes.statuses.get("representative") };
}

it("shows joins and leaves without a representative and clears the last membership", async () => {
	const { h, joined, role } = await online();
	expect(joined()).toBeUndefined();
	const before = h.session.sessionManager.getBranch();
	await h.session.prompt("/relay join ops");
	await waitFor(() => joined() === "#ops");
	await h.session.prompt("/relay join dev");
	await waitFor(() => joined() === "#dev #ops");
	expect(role()).toBeUndefined();
	await h.session.prompt("/relay leave ops");
	await waitFor(() => joined() === "#dev");
	await h.session.prompt("/relay leave dev");
	await waitFor(() => joined() === undefined);
	// Status publication does not write counters, messages, or other session entries.
	expect(h.session.sessionManager.getBranch()).toEqual(before);
	expect(h.errors).toEqual([]);
});

it("learns all joined rooms from full lists, sanitizes and sorts them stably, and follows server membership changes", async () => {
	const manager = SessionManager.create(workspace.cwd, workspace.sessionDir);
	const id = manager.getSessionId();
	for (const name of ["zeta", "ops", "infra", "docs", "dev", "build", "api", "\u001b[31malpha\u001b[0m\n\t\"\u202e\u200b"]) relay.addRoom(name, [id]);
	relay.addRoom("unjoined", ["other-session"]);
	const { h, joined, role, publish } = await online({ sessionManager: manager });
	const expected = "#alpha #api #build #dev #docs #infra #ops #zeta";
	await waitFor(() => joined() === expected);
	expect(role()).toBeUndefined();

	// A full list in a different order has the same status and causes no extra UI publication.
	const reversed = [...relay.rooms].reverse();
	relay.rooms.clear();
	for (const [name, room] of reversed) relay.rooms.set(name, room);
	publish.mockClear();
	await h.session.prompt("/relay rooms");
	expect(joined()).toBe(expected);
	expect(publish).not.toHaveBeenCalled();

	// A room frame asks for a fresh member-filtered list even when no representative changed.
	relay.addRoom("new", [id]);
	relay.send(id, { type: "room", room: "new" });
	await waitFor(() => joined() === "#alpha #api #build #dev #docs #infra #new #ops #zeta");
	relay.rooms.get("new")!.members.delete(id);
	relay.send(id, { type: "room", room: "new" });
	await waitFor(() => joined() === expected);
	expect(role()).toBeUndefined();
	expect(h.errors).toEqual([]);
});

it("publishes memberships and representative changes independently and clears both on shutdown", async () => {
	const { h, joined, role, publish, notes } = await online();
	const id = h.session.sessionId;
	setModes(id, "alwayson");
	await h.session.prompt("/relay represent dev");
	await waitFor(() => joined() === "#dev" && role() === "📣 rep #dev");

	publish.mockClear();
	await h.session.prompt("/relay join ops");
	await waitFor(() => joined() === "#dev #ops");
	expect(role()).toBe("📣 rep #dev");
	expect(publish.mock.calls).toEqual([["relay-rooms", "#dev #ops"]]);

	publish.mockClear();
	await h.session.prompt("/relay represent off dev");
	await waitFor(() => role() === undefined);
	expect(joined()).toBe("#dev #ops");
	expect(publish.mock.calls).toEqual([["representative", undefined]]);

	await h.session.prompt("/relay represent dev");
	await waitFor(() => role() === "📣 rep #dev");
	await h.shutdown();
	expect(notes.statuses.has("relay-rooms")).toBe(false);
	expect(notes.statuses.has("representative")).toBe(false);
	expect(h.errors).toEqual([]);
});

it("clears joined rooms when switching to an empty session, restores them on resume and reload, and clears on shutdown", async () => {
	const { h, joined, notes } = await online();
	const first = h.session.sessionId;
	await h.session.prompt("/relay join dev");
	await waitFor(() => joined() === "#dev");
	h.faux.setResponses([fauxAssistantMessage("saved")]);
	await h.session.prompt("save this session");
	const file = h.session.sessionFile!;

	await h.runtime.newSession();
	await waitOnline(relay, h.session.sessionId);
	expect(joined()).toBeUndefined();
	await h.session.prompt("/relay rooms");
	expect(joined()).toBeUndefined();

	await h.runtime.switchSession(file);
	expect(h.session.sessionId).toBe(first);
	await waitOnline(relay, first);
	await waitFor(() => joined() === "#dev");
	await h.session.reload();
	await waitOnline(relay, first);
	await waitFor(() => joined() === "#dev");

	await h.shutdown();
	expect(notes.statuses.has("relay-rooms")).toBe(false);
	expect(h.errors).toEqual([]);
});
