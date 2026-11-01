// A superagent family: a main session that created three concurrent tickets with `ticket_create`, each a long-running
// child that outlives its call, one with two grandchildren, and ticket reports arriving as main-session turns.
import type { ChildSession, Entry, SessionLink } from "../../src/lib/types";
import { assistantMessage, customMessage, entry, header, iso, summary, toolCall, toolResultMessage, turn, userMessage } from "./fixtures";
import type { FakeSession } from "./server";

export const MAIN = "main";

/** Ticket ids, their child sessions, titles, branches, and when each started and last worked (ms after T0). */
export const TICKETS = [
	{ id: 1, session: "tk1", call: "tc1", title: "Fix the parser", branch: "pi/1-fix-the-parser", start: 3_100, last: 243_000 },
	{ id: 2, session: "tk2", call: "tc2", title: "Add retries", branch: "pi/2-add-retries", start: 3_200, last: 420_000 },
	{ id: 3, session: "tk3", call: "tc3", title: "Bump deps", branch: "pi/3-bump-deps", start: 3_300, last: 380_000 },
] as const;

/** The ticket_create calls return at 3 s. */
export const CALLS_RETURN = 3_000;

export const SINGLE_REPORT = "#1 ready · Fix the parser\nAll tests pass; 2 commits ahead.";
export const BATCH_REPORT = "#2 question · Add retries\nShould retries back off exponentially?\n\n#3 merged · Bump deps\nMerged into main.";
export const IN_TURN_REPORT = "#2 blocked · Add retries\nWaiting on a decision.";
export const RELAY_TEXT = "[relay] Message from Planner on mini: please rebase.";

function link(extra: Partial<SessionLink> & { superagent?: unknown }): SessionLink {
	return { kind: "subagent", ...extra } as SessionLink;
}

function ticketChild(ticket: (typeof TICKETS)[number], childCount = 0): ChildSession {
	return {
		...summary(ticket.session, {
			parentSessionId: MAIN,
			title: `Ticket ${ticket.id}`,
			startedAt: iso(ticket.start),
			lastAt: iso(ticket.last),
			durationMs: ticket.last - ticket.start,
			childCount,
		}),
		parentToolCallId: ticket.call,
		link: link({
			parentSessionId: MAIN,
			parentToolCallId: ticket.call,
			agentType: "ticket",
			description: `#${ticket.id} ${ticket.title}`,
			superagent: { ticketId: ticket.id, branch: ticket.branch, title: ticket.title },
		}),
	};
}

function grandchild(id: string, call: string, agentType: string, description: string, start: number, last: number): ChildSession {
	return {
		...summary(id, { parentSessionId: "tk1", title: description, startedAt: iso(start), lastAt: iso(last), durationMs: last - start }),
		parentToolCallId: call,
		link: link({ parentSessionId: "tk1", parentToolCallId: call, agentType, description }),
	};
}

export const GRANDCHILDREN = [grandchild("g1", "gc1", "recon", "Map the parser", 10_000, 60_000), grandchild("g2", "gc2", "worker", "Patch the parser", 70_000, 200_000)];

function mainSession(): FakeSession {
	const children = [ticketChild(TICKETS[0], 2), ticketChild(TICKETS[1]), ticketChild(TICKETS[2])];
	const entries: Entry[] = [
		entry(0, header(MAIN)),
		entry(1, userMessage("Plan the release", 1000)),
		entry(2, assistantMessage(TICKETS.map((ticket) => toolCall(ticket.call, "ticket_create", { title: ticket.title, task: `Do: ${ticket.title}` })), 2000)),
		...TICKETS.map((ticket, i) => entry(3 + i, toolResultMessage(ticket.call, "ticket_create", `Created ticket #${ticket.id}`, { at: CALLS_RETURN }))),
		entry(6, assistantMessage([{ type: "text", text: "Started three tickets." }], 4000)),
		entry(7, customMessage("superagent-report", SINGLE_REPORT, 243_500, { ticketId: 1, kind: "ready", state: "ready", title: "Fix the parser", branch: TICKETS[0].branch, at: 1 })),
		entry(8, assistantMessage([{ type: "text", text: "Ticket 1 is ready to merge." }], 244_000)),
		entry(
			9,
			customMessage("superagent-report", BATCH_REPORT, 380_500, {
				batch: [
					{ ticketId: 2, kind: "question", state: "waiting", title: "Add retries", branch: TICKETS[1].branch, question: "Should retries back off exponentially?", at: 1 },
					{ ticketId: 3, kind: "merged", state: "merged", title: "Bump deps", branch: TICKETS[2].branch, at: 2 },
				],
			}),
		),
		entry(10, assistantMessage([{ type: "text", text: "Answering ticket 2." }], 381_000)),
		entry(11, userMessage("Status?", 400_000)),
		entry(12, assistantMessage([{ type: "text", text: "Checking." }], 401_000)),
		entry(13, customMessage("superagent-report", IN_TURN_REPORT, 402_000, { ticketId: 2, kind: "blocked", state: "blocked", title: "Add retries", reason: "Waiting on a decision.", at: 3 })),
		entry(14, assistantMessage([{ type: "text", text: "Ticket 2 is blocked." }], 403_000)),
		entry(15, customMessage("relay-message", RELAY_TEXT, 500_000)),
		entry(16, assistantMessage([{ type: "text", text: "Rebasing." }], 501_000)),
	];
	return {
		detail: summary(MAIN, { title: "Release router", entryCount: entries.length, startedAt: iso(0), lastAt: iso(501_000), childCount: 3, children }),
		entries,
		turns: [
			turn(0, 1, 6, { userText: "Plan the release", at: iso(1000), durationMs: 3000, modelCalls: 2, toolCalls: 3 }),
			turn(1, 7, 8, { userText: SINGLE_REPORT, customType: "superagent-report", at: iso(243_500), durationMs: 500, modelCalls: 1, toolCalls: 0 }),
			turn(2, 9, 10, { userText: BATCH_REPORT, customType: "superagent-report", at: iso(380_500), durationMs: 500, modelCalls: 1, toolCalls: 0 }),
			turn(3, 11, 14, { userText: "Status?", at: iso(400_000), durationMs: 3000, modelCalls: 2, toolCalls: 0 }),
			turn(4, 15, 16, { userText: RELAY_TEXT, customType: "relay-message", at: iso(500_000), durationMs: 1000, modelCalls: 1, toolCalls: 0 }),
		],
	};
}

function ticketSession(ticket: (typeof TICKETS)[number]): FakeSession {
	const detail = ticketChild(ticket, ticket.id === 1 ? 2 : 0);
	const entries: Entry[] = [entry(0, header(ticket.session)), entry(1, userMessage(`Do: ${ticket.title}`, ticket.start))];
	if (ticket.id === 1) {
		entries.push(
			entry(2, assistantMessage([toolCall("gc1", "Agent", { subagent_type: "recon", description: "Map the parser" })], 9_000)),
			entry(3, toolResultMessage("gc1", "Agent", "Mapped.", { at: 61_000 })),
			entry(4, assistantMessage([toolCall("gc2", "Agent", { subagent_type: "worker", description: "Patch the parser" })], 69_000)),
			entry(5, toolResultMessage("gc2", "Agent", "Patched.", { at: 201_000 })),
			entry(6, assistantMessage([{ type: "text", text: "Done." }], ticket.last)),
		);
	} else entries.push(entry(2, assistantMessage([{ type: "text", text: `${ticket.title}: done.` }], ticket.last)));
	const { parentToolCallId: _call, ...rest } = detail;
	return {
		detail: { ...rest, entryCount: entries.length, children: ticket.id === 1 ? GRANDCHILDREN : [] },
		entries,
		turns: [turn(0, 1, entries.length - 1, { userText: `Do: ${ticket.title}`, at: iso(ticket.start), durationMs: ticket.last - ticket.start, modelCalls: 3, toolCalls: 2 })],
	};
}

function grandchildSession(child: ChildSession): FakeSession {
	const start = Date.parse(child.startedAt) - Date.parse(iso(0));
	const last = Date.parse(child.lastAt) - Date.parse(iso(0));
	const entries: Entry[] = [entry(0, header(child.id)), entry(1, userMessage(child.title, start)), entry(2, assistantMessage([{ type: "text", text: "ok" }], last))];
	const { parentToolCallId: _call, ...rest } = child;
	return { detail: { ...rest, entryCount: entries.length, children: [] }, entries, turns: [turn(0, 1, 2, { userText: child.title, at: iso(start), durationMs: last - start })] };
}

/** The whole family, main session first. */
export function ticketFamily(): FakeSession[] {
	return [mainSession(), ...TICKETS.map(ticketSession), ...GRANDCHILDREN.map(grandchildSession)];
}
