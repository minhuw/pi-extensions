import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { timing, UNANSWERED } from "../../relay/protocol.ts";
import { endedText, memberText, representativeText, ROLE_TYPE } from "../../relay/roles.ts";
import { FakeRelay } from "./support/relay-server.ts";
import { type Harness, Notes, relayStatus, type SessionOptions, setCredentials, setModes, sleep, startSession, texts, waitFor, waitOnline, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
beforeEach(async () => { workspace = await Workspace.create(); relay = await new FakeRelay().start(); setCredentials(relay.url); });
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.shutdown();
	await relay.stop();
	await workspace.cleanup();
});

interface Member { h: Harness; notes: Notes; id: string; status(): string | undefined; command(text: string): Promise<void>; lastNote(): string | undefined }

async function online(options: Partial<SessionOptions> = {}): Promise<Member> {
	const notes = new Notes();
	const h = await startSession({ workspace, ui: notes.context(), ...options });
	harnesses.push(h);
	h.faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage("ok")));
	const id = h.session.sessionId;
	await waitOnline(relay, id);
	return {
		h, notes, id,
		status: () => notes.statuses.get("representative"),
		command: (text) => h.session.prompt(text),
		lastNote: () => notes.last?.message,
	};
}

/** Two sessions in #auth; the first is named Lead, and the server knows it. */
async function room(options: Partial<SessionOptions> = {}): Promise<[Member, Member]> {
	const lead = await online(options);
	const other = await online(options);
	lead.h.session.setSessionName("Lead");
	await waitFor(() => relay.online(lead.id)?.session?.name === "Lead", 5_000, "the name");
	for (const member of [lead, other]) await member.command("/relay join auth");
	return [lead, other];
}

async function represent(member: Member, name = "auth"): Promise<void> {
	setModes(member.id, "alwayson");
	await member.command(`/relay represent ${name}`);
	expect(member.lastNote()).toBe(`This session now represents you in #${name}: the room's other members report to it.`);
}

const roleTexts = (h: Harness) => h.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === ROLE_TYPE ? [entry.content] : []);
const contentOf = (h: Harness, id: string) => h.sent.find((sent) => (sent.message.details as { id?: string } | undefined)?.id === id)?.message.content as string;

it("refuses a representative without always-on mode, then tells every member which session represents the room", async () => {
	const [lead, other] = await room();
	await lead.command("/relay represent auth");
	expect(lead.notes.last).toEqual({ type: "warning", message: "Turn on /alwayson first: a representative must stay responsive." });
	expect(relay.rooms.get("auth")!.representative).toBeUndefined();
	// Frame types the session does not know are ignored.
	relay.send(other.id, { type: "future-frame", room: "auth" });

	await represent(lead);
	expect(relay.rooms.get("auth")!.representative).toBe(lead.id);
	expect(relay.roomFrames.map(({ sessionId, frame }) => [sessionId, frame.room, frame.representative])).toEqual(expect.arrayContaining([
		[lead.id, "auth", lead.id], [other.id, "auth", lead.id],
	]));
	await waitFor(() => lead.status() === "📣 rep #auth", 5_000, "the representative's status");
	await waitFor(() => other.status() === "→ rep Lead #auth", 5_000, "the member's status");
	expect(relayStatus(other.id)).toBe("online");

	await lead.command("/relay");
	expect(lead.lastNote()!.split("\n")).toContain("This session represents you in #auth.");
	await other.command("/relay");
	expect(other.lastNote()!.split("\n")).toContain(`#auth is represented by pi session ${lead.id} ("Lead").`);
	expect([...lead.h.errors, ...other.h.errors]).toEqual([]);
});

it("tells each model its role once, again after a compaction drops it or /tree leaves it off the branch, and once that it ended", async () => {
	const [lead, other] = await room({ keepRecentTokens: 1 });
	await other.command("zero");
	expect(roleTexts(other.h)).toEqual([]);
	const beforeRole = other.h.session.sessionManager.getLeafId()!;
	await represent(lead);
	await waitFor(() => other.status() === "→ rep Lead #auth", 5_000, "the member's status");

	const told = representativeText("auth");
	await lead.command("one");
	expect(roleTexts(lead.h)).toEqual([told]);
	await lead.command("two");
	expect(roleTexts(lead.h)).toEqual([told]);
	await lead.h.session.compact();
	await lead.command("three");
	expect(roleTexts(lead.h)).toEqual([told, told]);
	await lead.command("four");
	expect(roleTexts(lead.h)).toEqual([told, told]);

	const member = memberText("auth", `pi session ${lead.id} ("Lead")`);
	await other.command("one");
	expect(roleTexts(other.h)).toEqual([member]);
	await other.command("two");
	expect(roleTexts(other.h)).toEqual([member]);
	await other.h.session.navigateTree(beforeRole);
	expect(roleTexts(other.h)).toEqual([]);
	await other.command("other branch");
	expect(roleTexts(other.h)).toEqual([member]);
	for (const text of [told, member]) expect(Buffer.byteLength(text)).toBeLessThan(400);

	// Always-on mode goes off: the representative stops, says so, and every model hears it once.
	setModes(lead.id);
	await waitFor(() => relay.rooms.get("auth")!.representative === undefined, 5_000, "the unrepresent");
	await waitFor(() => lead.notes.messages.includes("Always-on mode is off, so this session no longer represents you in #auth."), 5_000, "the note");
	await waitFor(() => lead.status() === undefined && other.status() === undefined, 5_000, "the statuses");
	await lead.command("five");
	await lead.command("six");
	expect(roleTexts(lead.h)).toEqual([told, told, endedText("auth", "representative")]);
	await other.command("three");
	await other.command("four");
	expect(roleTexts(other.h)).toEqual([member, "You no longer report to a representative in #auth: your user reads this session again."]);
	// Hidden from the transcript.
	expect(lead.h.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === ROLE_TYPE ? [entry.display] : [])).toEqual([false, false, false]);
	expect([...lead.h.errors, ...other.h.errors]).toEqual([]);
});

it("leaves the unanswered paragraph out of room messages for a member that reports to a representative", async () => {
	const [lead, other] = await room();
	let answers = 0;
	const deliver = async (to: Member, message: Parameters<FakeRelay["push"]>[1]) => {
		const id = relay.push(to.id, message);
		await relay.waitForAck(to.id, id);
		answers++;
		await waitFor(() => texts(to.h.session, "assistant").length >= (to === other ? answers : 1), 5_000, "the turn");
		return contentOf(to.h, id);
	};
	expect(await deliver(other, { room: "auth", text: "status?" })).toContain(UNANSWERED);
	await represent(lead);
	await waitFor(() => other.status() === "→ rep Lead #auth", 5_000, "the member's status");

	const reported = await deliver(other, { room: "auth", text: "status?" });
	expect(reported).toContain("You were @mentioned in room #auth.");
	expect(reported).not.toContain(UNANSWERED);
	expect(await deliver(other, { text: "a direct message" })).toContain(UNANSWERED);
	expect(await deliver(other, { room: "misc", text: "another room" })).toContain(UNANSWERED);
	// The representative's user reads it.
	expect(await deliver(lead, { room: "auth", text: "my report" })).toContain(UNANSWERED);
	expect([...lead.h.errors, ...other.h.errors]).toEqual([]);
});

it("/relay represent off stops representing one room or all of them", async () => {
	const [lead, other] = await room();
	await lead.command("/relay join ops");
	await represent(lead);
	await represent(lead, "ops");
	await waitFor(() => lead.status() === "📣 rep #auth #ops" || lead.status() === "📣 rep #ops #auth", 5_000, "the status");

	await other.command("/relay represent off auth");
	expect(other.lastNote()).toBe("This session does not represent you in #auth.");
	expect(relay.rooms.get("auth")!.representative).toBe(lead.id);
	await lead.command("/relay represent off auth");
	expect(lead.lastNote()).toBe("This session no longer represents you in #auth.");
	expect(relay.rooms.get("auth")!.representative).toBeUndefined();
	await lead.command("/relay represent off #auth");
	expect(lead.lastNote()).toBe("This session does not represent you in #auth.");
	await lead.command("/relay represent off");
	expect(lead.lastNote()).toBe("This session no longer represents you in #ops.");
	expect(relay.rooms.get("ops")!.representative).toBeUndefined();
	await lead.command("/relay represent off");
	expect(lead.lastNote()).toBe("This session represents you in no room.");
	await waitFor(() => lead.status() === undefined, 5_000, "the cleared status");

	// Representing makes the session a member; leaving the room ends it.
	setModes(other.id, "alwayson");
	await other.command("/relay represent fresh");
	expect([...relay.rooms.get("fresh")!.members]).toEqual([other.id]);
	await other.command("/relay leave fresh");
	expect(relay.rooms.get("fresh")!.representative).toBeUndefined();
	await waitFor(() => other.status() === undefined, 5_000, "the member's cleared status");
	expect([...lead.h.errors, ...other.h.errors]).toEqual([]);
});

it("keeps representing through /reload and a quick return of always-on mode, and checks the mode again after the next start", async () => {
	// Always-on mode loads before relay and leaves the registry at every shutdown, /reload's too.
	let on = true;
	const alwayson: ExtensionFactory = (pi) => {
		pi.on("session_start", (_event, ctx) => { if (on) setModes(ctx.sessionManager.getSessionId(), "alwayson"); });
		pi.on("session_shutdown", (_event, ctx) => { setModes(ctx.sessionManager.getSessionId()); });
	};
	const [lead, other] = await room({ extensionsBefore: [alwayson] });
	await represent(lead);
	timing.modesGraceMs = 200;

	setModes(lead.id);
	setModes(lead.id, "alwayson");
	await sleep(400);
	expect(relay.rooms.get("auth")!.representative).toBe(lead.id);

	const connections = relay.connections.length;
	await lead.h.session.reload();
	await waitFor(() => relay.connections.length > connections && relay.online(lead.id) !== undefined, 5_000, "the reconnect");
	await sleep(400);
	expect(relay.rooms.get("auth")!.representative).toBe(lead.id);
	await waitFor(() => lead.status() === "📣 rep #auth", 5_000, "the status after /reload");

	// After this /reload always-on mode stays off, so the session stops once it lists its rooms.
	on = false;
	await lead.h.session.reload();
	await waitFor(() => relay.rooms.get("auth")!.representative === undefined, 5_000, "the unrepresent");
	await waitFor(() => lead.notes.messages.includes("Always-on mode is off, so this session no longer represents you in #auth."), 5_000, "the note");

	// A session the server makes representative without always-on mode stops too.
	setModes(other.id);
	relay.setRepresentative("auth", other.id);
	await waitFor(() => relay.rooms.get("auth")!.representative === undefined, 5_000, "the member's unrepresent");
	await waitFor(() => other.status() === undefined, 5_000, "the member's status");
	expect([...lead.h.errors, ...other.h.errors]).toEqual([]);
});

it("keeps the representative on the server when its session quits", async () => {
	const [lead, other] = await room();
	await represent(lead);
	await waitFor(() => other.status() === "→ rep Lead #auth", 5_000, "the member's status");
	await lead.h.shutdown();
	await sleep(timing.modesGraceMs + 200);
	expect(relay.rooms.get("auth")!.representative).toBe(lead.id);
	expect(other.status()).toBe("→ rep Lead #auth");
});
