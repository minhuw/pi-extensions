// pika relay end to end (docs/RELAY.md, "End to end"): two real `pi --mode rpc` processes with relay and pika, each
// logged in as its own device, talk through the real server. A asks B with relay_send and B's answer reaches A; a chain
// between them stops at the hop limit; `/relay off` takes B offline, and a message to it expires after the short test
// TTL with a notice that starts a turn in A; renaming A's device shows in relay's lists and on the dashboard; messages
// from the browser route and from the dashboard in Chrome reach B;
// B's uploaded transcript holds what it received; revoking B's device on the Devices page closes its connection with
// 4401. Run by driver.ts between the viewer and the authentication checks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockProvider, type ScriptedReply } from "../../../extensions/pika/tests/support/provider-server.ts";
import { allEntries, type ReadApi } from "./api.ts";
import type { Ui } from "./browser.ts";
import { agentDirFor, RpcPi, textOf, type SessionEntry } from "./rpc.ts";
import { check, checkEqual, log, waitFor } from "./util.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
/** Relay before pika, as in the repository's `pi.extensions`, and nothing else. */
const EXTENSIONS = ["extensions/relay/index.ts", "extensions/pika/index.ts"].map((path) => join(REPO, path));
const PROVIDER = "pika-e2e-relay";
const MODEL = "mock-model";
const MAX_HOPS = 8;

const QUESTION = "What is the build status?";
const ANSWER = "The build is green.";
const LATE = "Here is a late note.";
const WEB_ROUTE_TEXT = "Please run the tests too. (sent through the browser route)";
const WEB_UI_TEXT = "Thanks, that is all for today.\nSent from the Active sessions page.";
const READY = "Wait for messages from other sessions.";
const PROMPTS = {
	ask: (to: string) => `Ask session ${to} for the build status.`,
	chain: (to: string) => `Start a relay chain with session ${to}.`,
	late: (to: string) => `Send the late note to session ${to}.`,
};
const chainText = (hop: number) => `chain hop ${hop}`;
/** A's device name after the dashboard check renames it: free text, sorted before B's. */
const RENAMED_A = "Ana's workstation ✓";

export interface RelayTargets {
	url: string;
	api: ReadApi;
	/** Holds the two pi machines' agent dirs, projects, sessions, and logs. */
	root: string;
	/** Each pi process's pid is appended here for the script's trap. */
	pidFile: string;
	machines: { a: Machine; b: Machine };
	/** The server's PIKA_RELAY_TTL_SECS. */
	ttlSeconds: number;
}

/** `deviceId` is the device's id; `device` is its name, which relay shows. */
interface Machine { deviceId: string; device: string; token: string; name: string; project: string }

interface OnlineSession {
	id: string; device: string; deviceName?: string; host: string; name?: string; title?: string; cwd: string; project: string; model?: string;
	state: string; piVersion?: string; connectedAt: string; stateSince: string; lastSeenAt: string; recorded: boolean;
}
interface RelayEvent {
	id: string; at: string; from: { kind: string; sessionId?: string }; to: { sessionId: string }; status: string; reason?: string;
	deliveredAt?: string; urgent: boolean; replyTo?: string; hops: number; text: string;
}

type Sender = { sessionId: string; name: string; deviceId: string; device: string; project: string };

/** The content RELAY.md specifies for a message from a session. */
function sessionContent(id: string, from: Sender, text: string, replyTo?: string): string {
	return `[relay] Message ${id} from pi session ${from.sessionId} ("${from.name}") on ${from.device}, project ${from.project}${replyTo ? `, replying to ${replyTo}` : ""}:\n\n${text}\n\n`
		+ `This message came from another pi session through pika relay, not from your user. To answer, call relay_send with to "${from.sessionId}" and replyTo "${id}".`;
}

/** The content RELAY.md specifies for a message from the web UI. */
const webContent = (id: string, text: string) => `[relay] Message ${id} from your user in the pika web UI:\n\n${text}`;

/** A received relay message as the model reads it. */
function parseRelay(content: string): { id: string; from: string; text: string } | undefined {
	const session = /^\[relay\] Message (\S+) from pi session (\S+)[^\n]*:\n\n([\s\S]*)\n\nThis message came from another pi session/.exec(content);
	if (session) return { id: session[1]!, from: session[2]!, text: session[3]! };
	const web = /^\[relay\] Message (\S+) from your user in the pika web UI[^\n]*:\n\n([\s\S]*)$/.exec(content);
	return web ? { id: web[1]!, from: "web", text: web[2]! } : undefined;
}

/**
 * The scripted model of both sessions, by the last user message (a prompt, a relay message, or a notice) and how many
 * replies follow it. The sessions answer each other with relay_send, as a model following the message's hint would.
 */
export function relayResponder(body: Record<string, unknown>): ScriptedReply {
	const messages = (body.messages ?? []) as { role?: string; content?: unknown }[];
	let last = -1;
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") { last = i; break; }
	const prompt = last >= 0 ? textOf(messages[last]!.content) : "";
	const step = messages.slice(last + 1).filter((message) => message.role === "assistant").length;
	const script = (replies: ScriptedReply[]) => replies[Math.min(step, replies.length - 1)]!;
	const send = (args: Record<string, unknown>): ScriptedReply => ({ toolCalls: [{ name: "relay_send", arguments: args }] });
	let match: RegExpExecArray | null;
	if (prompt === READY) return "Ready for messages.";
	if ((match = /^Ask session (\S+) for the build status\.$/.exec(prompt))) return script([send({ to: match[1], text: QUESTION }), "I asked for the build status."]);
	if ((match = /^Start a relay chain with session (\S+)\.$/.exec(prompt))) return script([send({ to: match[1], text: chainText(1) }), "I started the chain."]);
	if ((match = /^Send the late note to session (\S+)\.$/.exec(prompt))) return script([send({ to: match[1], text: LATE }), "I sent the late note."]);
	if (prompt.startsWith("[relay] Your message ")) return "I noted that the late note expired.";
	const relay = parseRelay(prompt);
	if (relay?.from === "web") return "I got your message from the web UI.";
	if (relay?.text === QUESTION) return script([send({ to: relay.from, replyTo: relay.id, text: ANSWER }), "I answered the build question."]);
	if (relay?.text === ANSWER) return "The other session says the build is green.";
	const hop = relay && /^chain hop (\d+)$/.exec(relay.text);
	if (relay && hop) return script([send({ to: relay.from, replyTo: relay.id, text: chainText(Number(hop[1]) + 1) }), "I passed the chain on."]);
	return "This prompt has no script.";
}

const custom = (entries: SessionEntry[], type: string) => entries.filter((entry) => entry.type === "custom" && entry.customType === type);
const customMessages = (entries: SessionEntry[], type: string) => entries.filter((entry) => entry.type === "custom_message" && entry.customType === type);
const toolResults = (entries: SessionEntry[], name: string) =>
	entries.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === name);
const lastText = (entry: SessionEntry | undefined) => textOf(entry?.message?.content);

/** The entry after `entry` is the assistant's: the message started (or joined) a turn the model answered. */
function answered(entries: SessionEntry[], entry: SessionEntry, label: string): void {
	const at = entries.findIndex((item) => item.id === entry.id);
	check(at >= 0, `${label} is not in the session`);
	const next = entries[at + 1];
	checkEqual({ type: next?.type, role: next?.message?.role }, { type: "message", role: "assistant" }, `the entry after ${label}`);
}

export async function checkRelay(browser: Ui, t: RelayTargets): Promise<void> {
	const provider = await new MockProvider().start();
	provider.respond = (body) => relayResponder(body);
	const ttl = t.ttlSeconds;
	const startMachine = async (label: "a" | "b") => {
		const machine = t.machines[label];
		const home = join(t.root, label);
		const agentDir = join(home, "agent");
		agentDirFor(agentDir, { provider: PROVIDER, model: MODEL, baseUrl: provider.baseUrl, pikaUrl: t.url, token: machine.token });
		const pi = new RpcPi({
			label: label.toUpperCase(), cwd: join(home, machine.project), agentDir, sessionDir: join(home, "sessions"), extensions: EXTENSIONS,
			provider: PROVIDER, model: MODEL, name: machine.name, pidFile: t.pidFile, logFile: join(t.root, `pi-${label}.log`),
		});
		started.push(pi);
		await pi.start();
		return pi;
	};
	const started: RpcPi[] = [];
	const theme = browser.theme;
	try {
		const a = await startMachine("a");
		const b = await startMachine("b");
		const { a: ma, b: mb } = t.machines;
		const A: Sender = { sessionId: a.sessionId, name: ma.name, deviceId: ma.deviceId, device: ma.device, project: ma.project };
		const B: Sender = { sessionId: b.sessionId, name: mb.name, deviceId: mb.deviceId, device: mb.device, project: mb.project };
		log(`relay: A ${A.sessionId} on ${A.device} (${A.deviceId}), B ${B.sessionId} on ${B.device} (${B.deviceId})`);
		const settled = (label: string) => Promise.all([a.settled(60_000, label), b.settled(60_000, label)]);
		const events = async () => (await t.api.get<{ items: RelayEvent[] }>("relay/events?limit=500"))?.items ?? [];
		const deviceRoute = async (token: string) => {
			const response = await fetch(`${t.url}/api/relay/v1/sessions`, { headers: { authorization: `Bearer ${token}` } });
			return { status: response.status, items: response.status === 200 ? (await response.json() as { items: OnlineSession[] }).items : [] };
		};
		const online = async () => {
			const { status, items } = await deviceRoute(ma.token);
			checkEqual(status, 200, "the device route's status with A's token");
			return items;
		};
		const onlineIds = async () => (await online()).map((item) => item.id).sort();

		// 1. Both sessions are online, on the device route and the browser route.
		const noToken = await fetch(`${t.url}/api/relay/v1/sessions`);
		checkEqual({ status: noToken.status, body: await noToken.json() }, { status: 401, body: { error: "unauthorized" } }, "the device route without a token");
		await b.prompt(READY);
		const both = [A.sessionId, B.sessionId].sort();
		const listed = await waitFor(async () => {
			const items = await online();
			return items.length === 2 && items.find((item) => item.id === B.sessionId)?.recorded ? items : undefined;
		}, 15_000, "both sessions online, B recorded, on the device route");
		// Sorted by device name: Bo's notebook (B) before workstation (A).
		const shown = (items: OnlineSession[]) => items.map((item) => ({
			id: item.id, device: item.device, deviceName: item.deviceName, name: item.name, project: item.project, cwd: item.cwd.endsWith(`/${item.project}`), model: item.model, state: item.state,
		}));
		const onlineAs = (session: Sender) =>
			({ id: session.sessionId, device: session.deviceId, deviceName: session.device, name: session.name, project: session.project, cwd: true, model: `${PROVIDER}/${MODEL}`, state: "idle" });
		checkEqual(shown(listed), [onlineAs(B), onlineAs(A)], "the online sessions on the device route");
		checkEqual((await deviceRoute(mb.token)).items.map((item) => item.id), listed.map((item) => item.id), "the online sessions with B's token");
		checkEqual(((await t.api.get<{ items: OnlineSession[] }>("relay/sessions"))?.items ?? []).map((item) => item.id).sort(), both, "the online sessions on the browser route");
		log("relay: both sessions are online on the device and browser routes");

		// 2. A asks B with relay_send; B's turn starts with the message, and B's relay_send answer reaches A.
		await a.prompt(PROMPTS.ask(B.sessionId));
		const asked = toolResults(await a.entries(), "relay_send").at(-1);
		const delivered = /^Delivered message (\S+) to (.+?)\. Any answer arrives as a new \[relay\] message after your current turn ends/.exec(lastText(asked));
		check(delivered && !asked?.message?.isError && delivered[2]!.includes(B.sessionId), `A's relay_send answered ${JSON.stringify(lastText(asked))}`);
		const askId = delivered[1]!;
		const reply = await waitFor(async () => custom(await a.entries(), "relay-received").find((entry) => entry.data?.replyTo === askId), 20_000, "B's answer to reach A");
		await settled("the question and its answer");
		const bEntries = await b.entries();
		const received = custom(bEntries, "relay-received").find((entry) => entry.data?.id === askId);
		check(received, `B has no relay-received entry for ${askId}`);
		checkEqual({ ...received.data, at: typeof received.data?.at },
			{ id: askId, from: { kind: "session", sessionId: A.sessionId, device: A.deviceId, deviceName: A.device, name: A.name, title: A.name, project: A.project }, text: QUESTION, hops: 1, urgent: false, at: "string" },
			"B's relay-received entry for the question");
		const question = customMessages(bEntries, "relay-message").find((entry) => entry.details?.id === askId);
		check(question, `B has no relay-message for ${askId}`);
		checkEqual(question.content, sessionContent(askId, A, QUESTION), "the relay message B's model reads");
		checkEqual(question.display, true, "the relay message is displayed");
		check(bEntries.indexOf(received) < bEntries.indexOf(question), "B appended the receipt entry after the relay message");
		answered(bEntries, question, "the question in B");
		check(provider.bodies.some((raw) => {
			const messages = (JSON.parse(raw) as { messages: { role: string; content: unknown }[] }).messages;
			return textOf(messages.findLast((message) => message.role === "user")?.content) === sessionContent(askId, A, QUESTION);
		}), "no model call of B ends with the relay message");
		const answerSent = /^Delivered message (\S+) to /.exec(lastText(toolResults(bEntries, "relay_send").at(-1)));
		check(answerSent, `B's relay_send answered ${JSON.stringify(lastText(toolResults(bEntries, "relay_send").at(-1)))}`);
		checkEqual({ id: reply.data?.id, replyTo: reply.data?.replyTo, hops: reply.data?.hops }, { id: answerSent[1], replyTo: askId, hops: 2 }, "A's relay-received entry for the answer");
		const aEntries = await a.entries();
		const answer = customMessages(aEntries, "relay-message").find((entry) => entry.details?.id === answerSent[1]);
		check(answer, "A has no relay-message for the answer");
		checkEqual(answer.content, sessionContent(answerSent[1]!, B, ANSWER, askId), "the answer A's model reads");
		answered(aEntries, answer, "the answer in A");
		log(`relay: A asked B (${askId}, hops 1); B's turn started with it and its answer ${answerSent[1]} (hops 2) reached A`);

		// 3. A chain between the sessions without the user stops at the hop limit.
		await a.prompt(PROMPTS.chain(B.sessionId));
		const cut = await waitFor(async () => toolResults(await a.entries(), "relay_send").find((entry) => lastText(entry).includes("(hop_limit)")), 60_000, "the chain to reach the hop limit");
		await settled("the chain");
		check(cut.message?.isError && lastText(cut).startsWith("relay rejected the message (hop_limit):"), `the cut relay_send answered ${JSON.stringify(lastText(cut))}`);
		const chain = (await events()).filter((event) => /^chain hop \d+$/.test(event.text)).reverse();
		checkEqual(chain.map((event) => ({ text: event.text, hops: event.hops, status: event.status, reason: event.reason, from: event.from.sessionId })),
			Array.from({ length: MAX_HOPS + 1 }, (_, i) => ({
				text: chainText(i + 1), hops: i + 1, status: i < MAX_HOPS ? "delivered" : "rejected", reason: i < MAX_HOPS ? undefined : "hop_limit",
				from: i % 2 === 0 ? A.sessionId : B.sessionId,
			})), "the chain's events");
		const hopsOf = async (pi: RpcPi) => custom(await pi.entries(), "relay-received").map((entry) => entry.data?.hops);
		checkEqual({ a: await hopsOf(a), b: await hopsOf(b) }, { a: [2, 2, 4, 6, 8], b: [1, 1, 3, 5, 7] }, "the hops of every message each session received");
		const hopEvent = chain.at(-1)!;
		log(`relay: the chain ran ${MAX_HOPS} hops and A's ninth send was rejected with hop_limit`);

		// 4. `/relay off` takes B offline; a message to it expires after the TTL, and the notice starts a turn in A.
		const off = await b.prompt("/relay off");
		check(off.some((note) => note.message.startsWith("Relay is off for this session")), `/relay off showed ${JSON.stringify(off)}`);
		await waitFor(async () => (await onlineIds()).join() === A.sessionId, 10_000, "B to go offline");
		const status = (await b.prompt("/relay")).at(-1)?.message ?? "";
		check(status.startsWith("Relay is offline: relay is off for this session (/relay off)"), `/relay after /relay off says ${JSON.stringify(status)}`);
		await a.prompt(PROMPTS.late(B.sessionId));
		const queuedText = lastText(toolResults(await a.entries(), "relay_send").at(-1));
		const queued = new RegExp(`^Queued message (\\S+) for (.+): it has not been delivered yet\\. If it is not delivered within ${ttl} seconds it is dropped and you will get a notice\\. Any answer arrives`).exec(queuedText);
		check(queued && queued[2]!.includes(B.sessionId), `A's relay_send to the offline B answered ${JSON.stringify(queuedText)}`);
		const [lateId, lateLabel] = [queued[1]!, queued[2]!];
		const acceptedAt = Date.parse((await events()).find((event) => event.id === lateId)?.at ?? "");
		const notice = await waitFor(async () => customMessages(await a.entries(), "relay-notice").find((entry) => textOf(entry.content).includes(lateId)), (ttl + 15) * 1000, "the expiry notice in A");
		// The server and this driver share a clock; the notice is seen within a poll of its arrival.
		const noticedAfter = Date.now() - acceptedAt;
		await a.settled(30_000, "the expiry notice");
		checkEqual(notice.content, `[relay] Your message ${lateId} to ${lateLabel} expired: it was not delivered within ${ttl} seconds and was dropped.`, "the expiry notice");
		answered(await a.entries(), notice, "the expiry notice in A");
		checkEqual((await events()).find((event) => event.id === lateId)?.status, "expired", "the late note's event");
		check(noticedAfter >= ttl * 1000, `the notice came ${noticedAfter} ms after the server accepted the message, before the ${ttl} s TTL`);
		log(`relay: B went offline with /relay off; ${lateId} expired and its notice started a turn in A ${noticedAfter} ms after the server accepted it`);

		// 5. `/relay on` brings B back; the expired message is not delivered.
		const on = await b.prompt("/relay on");
		check(on.some((note) => note.message.startsWith("Relay is on for this session")), `/relay on showed ${JSON.stringify(on)}`);
		await waitFor(async () => (await onlineIds()).join() === both.join(), 15_000, "B to come back online");
		check(!custom(await b.entries(), "relay-received").some((entry) => entry.data?.id === lateId), "B received the expired message after /relay on");

		// 6. A message from the browser route reaches B and starts its turn; an unknown target is refused.
		const sent = await t.api.post<{ id: string; status: string; to: { sessionId: string; device?: string; deviceName?: string; name?: string } }>("relay/messages", { to: B.sessionId, text: WEB_ROUTE_TEXT });
		checkEqual({ status: sent.status, delivery: sent.body.status, to: [sent.body.to?.sessionId, sent.body.to?.device, sent.body.to?.deviceName, sent.body.to?.name] },
			{ status: 200, delivery: "delivered", to: [B.sessionId, B.deviceId, B.device, B.name] }, "POST relay/messages to B");
		const refused = await t.api.post<{ error: string }>("relay/messages", { to: "no-such-session", text: "hello" });
		checkEqual({ status: refused.status, body: refused.body }, { status: 400, body: { error: "unknown_session" } }, "POST relay/messages to an unknown session");
		const webRoute = await waitFor(async () => customMessages(await b.entries(), "relay-message").find((entry) => entry.details?.id === sent.body.id), 10_000, "the browser route's message in B");
		await b.settled(30_000, "the browser route's message");
		checkEqual(webRoute.content, webContent(sent.body.id, WEB_ROUTE_TEXT), "the browser route's message as B's model reads it");
		checkEqual(custom(await b.entries(), "relay-received").find((entry) => entry.data?.id === sent.body.id)?.data?.from, { kind: "web" }, "the sender of the browser route's message");
		answered(await b.entries(), webRoute, "the browser route's message in B");
		log(`relay: the browser route's message ${sent.body.id} reached B and started a turn`);

		// 7. Renaming A's device on the Devices page shows in the next relay answers and on the dashboard, which lists
		// both sessions by device, sorted by name, and the messages, in both themes.
		await browser.go("/devices");
		await browser.click(`[data-device="${A.deviceId}"] button[aria-label^="Rename"]`);
		await browser.visible("[data-dialog=rename] input");
		await browser.page.$eval("[data-dialog=rename] input", (input) => (input as HTMLInputElement).select());
		await browser.page.type("[data-dialog=rename] input", RENAMED_A);
		await browser.click("[data-dialog=rename] button[type=submit]");
		await browser.visible("[data-notice=green]");
		checkEqual(await browser.textOf("[data-notice=green]"), `Renamed ${A.device} to ${RENAMED_A}.`, "the notice after renaming A's device");
		checkEqual(await browser.textOf(`[data-device="${A.deviceId}"] [data-device-label]`), RENAMED_A, "A's device row after the rename");
		const renamedA: Sender = { ...A, device: RENAMED_A };
		// Ana's workstation now sorts before Bo's notebook.
		checkEqual(shown(await online()), [onlineAs(renamedA), onlineAs(B)], "the online sessions on the device route after renaming A's device");
		checkEqual(((await t.api.get<{ items: OnlineSession[] }>("relay/sessions"))?.items ?? []).map((item) => [item.id, item.deviceName]),
			[[A.sessionId, RENAMED_A], [B.sessionId, B.device]], "the online sessions on the browser route after renaming A's device");
		await browser.go("/active");
		for (const session of [renamedA, B]) await browser.visible(`[data-relay-device="${session.deviceId}"][data-device-name="${session.device}"] [data-online-session="${session.sessionId}"]`);
		checkEqual(await browser.page.$$eval("[data-relay-device]", (nodes) => nodes.map((node) => node.getAttribute("data-relay-device"))), [A.deviceId, B.deviceId], "the dashboard's device groups");
		check((await browser.textOf(`[data-relay-device="${A.deviceId}"] h3`)).includes(RENAMED_A), "A's device group is not headed by its new name");
		for (const id of [askId, answerSent[1]!, hopEvent.id, lateId, sent.body.id]) await browser.visible(`[data-relay-event="${id}"]`);
		checkEqual(await browser.page.$eval(`[data-relay-event="${hopEvent.id}"]`, (node) => node.getAttribute("data-status")), "rejected", "the dashboard's status of the cut chain message");
		checkEqual(await browser.page.$eval(`[data-relay-event="${lateId}"]`, (node) => node.getAttribute("data-status")), "expired", "the dashboard's status of the late note");
		check((await browser.textOf(`[data-online-session="${B.sessionId}"]`)).includes(B.name), "B's row does not show its name");
		check((await browser.textOf("[data-online-count]")).includes("2"), "the sidebar does not count 2 online sessions");
		for (const each of ["light", "dark"] as const) {
			await browser.setTheme(each);
			await browser.page.$eval("[data-scroll-root]", (root) => { root.scrollTop = 0; }).catch(() => {});
			await browser.shot("19-active");
		}
		log("relay: the dashboard lists both sessions and the messages");

		// 8. Message → Send on the dashboard reaches B.
		await browser.click(`[data-online-session="${B.sessionId}"] button[aria-label^="Message"]`);
		const dialog = `[data-message-dialog="${B.sessionId}"]`;
		await browser.visible(`${dialog} textarea`);
		await browser.page.type(`${dialog} textarea`, WEB_UI_TEXT);
		await browser.click(`${dialog} button::-p-text(Send)`);
		await browser.visible(`${dialog} [data-send-result="delivered"]`);
		check((await browser.textOf(`${dialog} [data-send-result]`)).startsWith(`Delivered to ${B.name}`), `the dialog says ${JSON.stringify(await browser.textOf(`${dialog} [data-send-result]`))}`);
		await browser.shot("20-active-message");
		const fromUi = await waitFor(async () => customMessages(await b.entries(), "relay-message").find((entry) => entry.details?.text === WEB_UI_TEXT), 10_000, "the dashboard's message in B");
		await b.settled(30_000, "the dashboard's message");
		const uiId = String(fromUi.details?.id);
		checkEqual(fromUi.content, webContent(uiId, WEB_UI_TEXT), "the dashboard's message as B's model reads it");
		answered(await b.entries(), fromUi, "the dashboard's message in B");
		await browser.page.keyboard.press("Escape");
		await browser.page.waitForSelector(dialog, { hidden: true });
		await browser.visible(`[data-relay-event="${uiId}"][data-status="delivered"]`);
		log(`relay: Message → Send on the dashboard delivered ${uiId} to B`);

		// 9. B's session page shows it online.
		await browser.go(`/s/${encodeURIComponent(B.sessionId)}`);
		await browser.visible("[data-online]");
		for (const each of ["light", "dark"] as const) {
			await browser.setTheme(each);
			await browser.shot("21-session-online");
		}
		browser.noProblems("on the relay pages");

		// 10. B's transcript in pika holds every receipt and relay message.
		const bFile = (await b.command<{ sessionFile?: string }>({ type: "get_state" })).sessionFile;
		check(bFile, "B has no session file");
		const local = readFileSync(bFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionEntry);
		const uploaded = await waitFor(async () => {
			const entries = await allEntries(t.api, B.sessionId);
			return entries && entries.length === local.length ? entries : undefined;
		}, 15_000, "B's transcript to upload");
		const ids = (entries: { type?: string; customType?: string; data?: { id?: unknown }; details?: { id?: unknown } }[], type: string) =>
			entries.filter((entry) => entry.customType === type).map((entry) => (type === "relay-received" ? entry.data?.id : entry.details?.id));
		const raws = uploaded.map((entry) => entry.raw as { customType?: string; data?: { id?: unknown }; details?: { id?: unknown } });
		const expected = custom(local, "relay-received").map((entry) => entry.data?.id);
		check(expected.includes(askId) && expected.includes(sent.body.id) && expected.includes(uiId), `B's file lacks receipts: ${JSON.stringify(expected)}`);
		checkEqual(ids(raws, "relay-received"), expected, "the relay-received entries in B's uploaded transcript");
		checkEqual(ids(raws, "relay-message"), expected, "the relay-message entries in B's uploaded transcript");
		log(`relay: B's uploaded transcript holds ${expected.length} relay-received entries and their relay messages`);

		// 11. Revoking B's device on the Devices page closes its relay connection with 4401.
		await browser.go("/devices");
		await browser.click(`[data-device="${B.deviceId}"] button[aria-label^="Revoke"]`);
		await browser.click("[role=dialog] button::-p-text(Revoke)");
		await browser.visible("[data-notice=green]");
		await waitFor(async () => (await onlineIds()).join() === A.sessionId, 10_000, "B to go offline after the revocation");
		checkEqual((await deviceRoute(mb.token)).status, 401, "the device route with B's revoked token");
		let said = "";
		await waitFor(async () => {
			said = (await b.prompt("/relay")).at(-1)?.message ?? "";
			return said.includes("close code 4401");
		}, 10_000, "/relay in B to report the 4401 close").catch((error: Error) => { throw new Error(`${error.message}; /relay says:\n${said}`); });
		check(said.startsWith("Relay is offline: the server revoked this device's token (close code 4401)"), `/relay after the revocation says ${JSON.stringify(said)}`);
		browser.noProblems("while revoking B's device");
		log("relay: revoking B's device closed its connection; /relay reports close code 4401");

		await a.checkNoErrors();
		await b.checkNoErrors();
		for (const pi of [b, a]) await pi.stop();
		await waitFor(async () => (await onlineIds()).length === 0, 10_000, "both sessions to go offline after pi exits");
		log("relay: both sessions went offline when pi exited");
	} finally {
		for (const pi of started) await pi.stop();
		await provider.stop();
		await browser.setTheme(theme).catch(() => {});
	}
}
