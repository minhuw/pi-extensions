// pika end to end: a real pi runtime with Subagents, Herder, and pika uploads to the real server through a mock
// provider; the read API must return every entry and request verbatim, across a server outage and a pi restart, and
// the embedded UI must render it in the locally installed Chrome. Then a new machine pairs through `/pika login` while
// the browser denies and approves it, the browser revokes it, signs out, and finally hits the login rate limit.
// Run by services/pika/scripts/e2e.sh.
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MockProvider } from "../../../extensions/pika/tests/support/provider-server.ts";
import { ScriptedUI } from "../../../extensions/pika/tests/support/ui.ts";
import { allEntries, ReadApi, type Entry, type ModelRequest, type RunDetail, type SessionDetail, type Turn } from "./api.ts";
import { checkApprovedPairing, checkBrowserSessions, checkDeniedPairing, checkDevices, checkLoginRateLimit, type NewMachine } from "./auth.ts";
import { checkViewer, openBrowser, type Ui } from "./browser.ts";
import { ingestSession, largeSession } from "./large.ts";
import { AGENT_CALL_ID, createProject, LOCAL_PROVIDER, NOTICE_AFTER_CALL_ID, NOTICE_TYPE, PROMPTS, responder, SEARCH_WORD, startPi, type Pi } from "./scenario.ts";
import { PikaServer } from "./server.ts";
import { check, checkEqual, env, log, sleep, waitFor } from "./util.ts";
import { SessionWatcher } from "./watch.ts";

/** AC-1: each entry is retrievable from the read API within this long of being written. */
const UPLOAD_MS = 5_000;
/** How long the uploader may take to deliver what it queued while the server was down, given its backoff. */
const RECOVERY_MS = 120_000;
const OUTAGE_MS = 4_000;

const work = env("PIKA_E2E_WORK");
const password = env("PIKA_PASSWORD");
const basePath = env("PIKA_E2E_BASE_PATH");
const server = new PikaServer({
	bin: env("PIKA_E2E_BIN"), dataDir: env("PIKA_E2E_DATA"), port: Number(env("PIKA_E2E_PORT")), basePath,
	pidFile: env("PIKA_E2E_PIDFILE"), logFile: env("PIKA_E2E_SERVER_LOG"),
});

const root = join(work, "pi");
/** The machine that joins by pairing keeps its pi state outside `root`, which the session watcher scans. */
const machineRoot = join(work, "machine");
const PAIRED_DEVICE = "e2e-paired";
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const cwd = join(root, "demo");
for (const dir of [agentDir, sessionDir, cwd]) mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const name of ["PIKA_URL", "PIKA_TOKEN", "PIKA_DISABLED"]) delete process.env[name];
writeFileSync(join(agentDir, "pika.json"), JSON.stringify({ url: server.url, token: env("PIKA_E2E_TOKEN_LAPTOP"), enabled: true }));

const read = (path: string) => readFileSync(path, "utf8");
const lines = (path: string) => read(path).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
const spooledRequests = () => readdirSync(join(agentDir, "pika", "spool", "requests")).filter((name) => name.endsWith(".json"));
const linkOf = (path: string) => lines(path).find((entry) => entry.type === "custom" && entry.customType === "pi-extensions.session-link")?.data as Record<string, unknown> | undefined;

async function main(): Promise<void> {
	createProject(cwd);
	const provider = await new MockProvider().start();
	provider.respond = (body) => responder(body);
	const local = fauxProvider({ api: "pika-e2e-faux", provider: LOCAL_PROVIDER, models: [{ id: "local" }] });
	const api = new ReadApi(server.url, password);
	await api.login();
	const watcher = new SessionWatcher([root], api);
	watcher.start();
	let pi: Pi | undefined;
	try {
		pi = await startPi({ cwd, agentDir, sessionDir, provider, local });
		const mainId = pi.session.sessionId;
		log(`main session ${mainId}`);
		for (const prompt of [PROMPTS.inspect, PROMPTS.delegate, PROMPTS.herder]) {
			await pi.prompt(prompt);
			log(`prompted: ${prompt}`);
		}
		checkEqual(pi.approvals.length, 1, "Herder asks the user to approve the goal once");
		const mainFile = pi.session.sessionFile!;

		const sessions = () => {
			watcher.scan();
			return watcher.sessions();
		};
		const child = await waitFor(() => sessions().find(({ path }) => linkOf(path)?.kind === "subagent"), 10_000, "the subagent's session file");
		const step = await waitFor(() => sessions().find(({ path }) => linkOf(path)?.kind === "herder-step"), 10_000, "the Herder step's session file");
		log(`subagent session ${child.sessionId}, Herder step session ${step.sessionId}`);
		await allServed(watcher, 15_000, "the first prompts");

		// Server outage: pi keeps working, pika queues on disk, and a restarted pi resumes the session.
		const stopAt = Date.now();
		await server.stop();
		log("server stopped");
		await pi.prompt(PROMPTS.offline);
		const spooled = await waitFor(() => spooledRequests().length >= 2 && spooledRequests(), 5_000, "the offline prompt's requests to be queued on disk");
		log(`${spooled.length} request(s) queued on disk while the server is down`);
		await pi.shutdown();
		pi = await startPi({ cwd, agentDir, sessionDir, provider, local, sessionFile: mainFile });
		checkEqual(pi.session.sessionId, mainId, "the restarted pi resumes the main session");
		await pi.prompt(PROMPTS.resumed);
		log("pi restarted and prompted while the server is down");
		// Long enough for the uploader to fail and back off a few times.
		await sleep(OUTAGE_MS);
		await server.start();
		const restartAt = Date.now();
		log("server restarted");
		await allServed(watcher, RECOVERY_MS, "the entries queued during the outage");
		const recoveredAt = Date.now();
		log(`delivered the queued entries ${recoveredAt - restartAt} ms after the restart`);
		await pi.prompt(PROMPTS.online);
		// A provider that exposes no payload: pika records the context pi built for the call instead.
		await pi.session.setModel(local.getModel("local")!);
		local.setResponses([fauxAssistantMessage("The local model answers without a provider payload.")]);
		await pi.prompt(PROMPTS.local);
		const localContext = pi.contexts.at(-1)!;
		await allServed(watcher, 15_000, "the entries after recovery");
		await waitFor(() => spooledRequests().length === 0, 15_000, "the request spool to drain");
		const herderRun = herderRunId();
		await pi.shutdown();
		pi = undefined;
		await allServed(watcher, 15_000, "the entries written at shutdown");
		watcher.stop();

		checkLatency(watcher, { from: stopAt, to: recoveredAt });
		await checkExports(api, watcher);
		await checkRequests(api, provider, watcher, localContext);
		await checkLinks(api, { mainId, childId: child.sessionId, stepId: step.sessionId, runId: herderRun });
		await checkTurns(api, mainId, mainFile);

		const large = largeSession();
		await ingestSession(server.url, env("PIKA_E2E_TOKEN_DESKTOP"), large);
		check(await api.text(`sessions/${large.id}/export`) === large.text, "the 5,000-entry session does not export byte for byte");
		log(`loaded the 5,000-entry session ${large.id}`);

		const browser = await openBrowser({ url: server.url, chrome: env("PIKA_E2E_CHROME"), artifacts: env("PIKA_E2E_ARTIFACTS"), profile: join(work, "chrome-profile") });
		try {
			await checkViewer(browser, {
				password, mainId, childId: child.sessionId, stepId: step.sessionId, runId: herderRun, largeId: large.id, searchWord: SEARCH_WORD,
				prompts: [PROMPTS.inspect, PROMPTS.delegate, PROMPTS.herder, PROMPTS.offline, PROMPTS.resumed, PROMPTS.online, PROMPTS.local],
				herderPrompt: PROMPTS.herder,
			});
			await checkAuth(browser, { api, provider, local });
			log(`browser: ${browser.shots.length} screenshots`);
		} finally {
			await browser.close();
		}
	} finally {
		watcher.stop();
		await pi?.shutdown();
		await provider.stop();
	}
}

/**
 * A second machine, with its own agent dir and no `pika.json`, pairs while the browser denies and then approves it;
 * the browser revokes it and signs out; the login rate limit comes last, since every client here is 127.0.0.1.
 */
async function checkAuth(browser: Ui, options: { api: ReadApi; provider: MockProvider; local: ReturnType<typeof fauxProvider> }): Promise<void> {
	const agent = join(machineRoot, "agent");
	const sessions = join(machineRoot, "sessions");
	for (const dir of [agent, sessions]) mkdirSync(dir, { recursive: true });
	// pika reads its agent dir from the environment when a command runs.
	process.env.PI_CODING_AGENT_DIR = agent;
	const ui = new ScriptedUI();
	const { notify, input, select } = ui.context();
	const machine: NewMachine = {
		agentDir: agent, ui, secrets: [env("PIKA_E2E_TOKEN_LAPTOP"), env("PIKA_E2E_TOKEN_DESKTOP")],
		pi: await startPi({ cwd, agentDir: agent, sessionDir: sessions, provider: options.provider, local: options.local, dialogs: { notify, input, select } }),
	};
	const t = { url: server.url, password, api: options.api, device: PAIRED_DEVICE };
	try {
		await checkDeniedPairing(browser, machine, t);
		await browser.setTheme("light");
		const token = await checkApprovedPairing(browser, machine, t);
		await checkDevices(browser, machine, t, token);
		checkEqual(machine.pi.errors, [], "extension errors on the paired machine");
	} finally {
		await machine.pi.shutdown();
		process.env.PI_CODING_AGENT_DIR = agentDir;
	}
	await checkBrowserSessions(browser, t);
	await checkLoginRateLimit(browser, t);
}

function herderRunId(): string {
	const runs = readdirSync(join(cwd, ".git", "herder", "runs"));
	checkEqual(runs.length, 1, "the project has one Herder run");
	return runs[0]!;
}

/** Waits until the read API has returned every complete line of every session file. */
async function allServed(watcher: SessionWatcher, timeoutMs: number, label: string): Promise<void> {
	await waitFor(() => {
		watcher.scan();
		return [...watcher.files.values()].every((file) => !file.sessionId || [...file.written.keys()].every((offset) => file.served.has(offset)));
	}, timeoutMs, `the read API to return ${label}`, 100);
}

/**
 * Every line written outside the outage reached the read API within `UPLOAD_MS`. Every line written before the server
 * stopped was served before it stopped, so only lines from the stop until the queue was delivered are exempt.
 */
function checkLatency(watcher: SessionWatcher, outage: { from: number; to: number }): void {
	let measured = 0;
	let worst = 0;
	const late: string[] = [];
	for (const file of watcher.files.values()) {
		if (!file.sessionId) continue;
		for (const [offset, written] of file.written) {
			const served = file.served.get(offset);
			check(served !== undefined, `${file.sessionId} byte ${offset} never reached the read API`);
			if (written >= outage.from && written <= outage.to) continue;
			measured++;
			worst = Math.max(worst, served - written);
			if (served - written > UPLOAD_MS) late.push(`${file.sessionId}@${offset}: ${served - written} ms`);
		}
	}
	check(late.length === 0, `entries reached the read API later than ${UPLOAD_MS} ms after they were written:\n  ${late.join("\n  ")}`);
	log(`upload latency: ${measured} entries, worst ${worst} ms`);
}

/** Every session file exports byte for byte. */
async function checkExports(api: ReadApi, watcher: SessionWatcher): Promise<void> {
	for (const { sessionId, path } of watcher.sessions()) {
		const exported = await api.text(`sessions/${sessionId}/export`);
		check(exported === read(path), `the export of ${sessionId} differs from ${path}`);
	}
	log(`${watcher.sessions().length} sessions export byte for byte`);
}

const completeRequest = (api: ReadApi, id: string) => waitFor(async () => {
	const value = await api.get<ModelRequest>(`requests/${id}`);
	return value?.complete ? value : undefined;
}, 10_000, `request ${id} to be complete`);

/**
 * Every body the provider received is stored as the request of the assistant entry it produced, and the call to the
 * local model as its context with fidelity `context`, with no extra or duplicate requests per session.
 */
async function checkRequests(api: ReadApi, provider: MockProvider, watcher: SessionWatcher, localContext: unknown[]): Promise<void> {
	const byResponse = new Map<string, { sessionId: string; entry: Entry }>();
	const locals: { sessionId: string; entry: Entry }[] = [];
	for (const { sessionId } of watcher.sessions()) {
		for (const entry of (await allEntries(api, sessionId)) ?? []) {
			const message = entry.raw.message as { role?: string; responseId?: string; provider?: string } | undefined;
			if (entry.type !== "message" || message?.role !== "assistant") continue;
			if (message.provider === LOCAL_PROVIDER) locals.push({ sessionId, entry });
			else if (message.responseId) byResponse.set(message.responseId, { sessionId, entry });
		}
	}
	checkEqual(byResponse.size, provider.bodies.length, "one assistant entry per provider call");
	checkEqual(locals.length, 1, "one assistant entry from the local model");
	const perSession = new Map<string, number>();
	const { sessionId: localSession, entry: localEntry } = locals[0]!;
	check(localEntry.requestId, "the local model's assistant entry has no requestId");
	const context = await completeRequest(api, localEntry.requestId);
	checkEqual({ sessionId: context.sessionId, fidelity: context.fidelity }, { sessionId: localSession, fidelity: "context" }, "the local model's request");
	checkEqual(context.payload, { messages: localContext }, "the local model's stored request differs from the context pi built for it");
	check((localContext[0] as { role?: string }).role === "system", "the recorded context has no system message");
	perSession.set(localSession, 1);
	for (const [index, body] of provider.bodies.entries()) {
		const responseId = provider.responseIds[index]!;
		const found = byResponse.get(responseId);
		check(found, `no assistant entry carries the response ${responseId}`);
		const { sessionId, entry } = found;
		check(entry.requestId, `the assistant entry ${sessionId}#${entry.seq} (${responseId}) has no requestId`);
		const request = await completeRequest(api, entry.requestId);
		checkEqual({ sessionId: request.sessionId, fidelity: request.fidelity }, { sessionId, fidelity: "payload" }, `request ${request.id}`);
		checkEqual(request.payload, JSON.parse(body), `the stored request ${request.id} differs from the body the provider received for ${responseId}`);
		perSession.set(sessionId, (perSession.get(sessionId) ?? 0) + 1);
	}
	const db = new DatabaseSync(join(env("PIKA_E2E_DATA"), "pika.db"), { readOnly: true });
	try {
		const rows = db.prepare("SELECT session_id AS sessionId, COUNT(*) AS n FROM requests GROUP BY session_id").all() as { sessionId: string; n: number }[];
		checkEqual(Object.fromEntries(rows.map((row) => [row.sessionId, Number(row.n)])), Object.fromEntries(perSession), "stored requests per session");
	} finally {
		db.close();
	}
	log(`${provider.bodies.length} provider bodies and 1 context match their stored requests, ${perSession.size} sessions, no duplicates`);
}

async function checkLinks(api: ReadApi, ids: { mainId: string; childId: string; stepId: string; runId: string }): Promise<void> {
	const { mainId, childId, stepId, runId } = ids;
	const main = await api.get<SessionDetail>(`sessions/${mainId}`);
	check(main, "the main session is missing");
	const child = main.children.find((item) => item.id === childId);
	check(child, `the main session does not list the subagent ${childId} as a child`);
	checkEqual(child.parentToolCallId, AGENT_CALL_ID, "the subagent links to the parent's Agent tool call");
	const childDetail = await api.get<SessionDetail>(`sessions/${childId}`);
	checkEqual({ parent: childDetail?.parentSessionId, kind: childDetail?.link?.kind, agentType: childDetail?.link?.agentType },
		{ parent: mainId, kind: "subagent", agentType: "worker" }, "the subagent's link");

	const stepDetail = await api.get<SessionDetail>(`sessions/${stepId}`);
	checkEqual({ parent: stepDetail?.parentSessionId, kind: stepDetail?.link?.kind, run: stepDetail?.herderRunId },
		{ parent: mainId, kind: "herder-step", run: runId }, "the Herder step session's link");
	const runDir = join(cwd, ".git", "herder", "runs", runId);
	const journal = read(join(runDir, "journal.jsonl")).split("\n").filter(Boolean);
	const run = await waitFor(async () => {
		const value = await api.get<RunDetail>(`herder/runs/${runId}`);
		return value && value.events.length === journal.length && value.goal !== undefined && value.plan !== undefined ? value : undefined;
	}, 10_000, "the Herder run's journal, goal, and plan");
	checkEqual(run.goal, read(join(runDir, "goal.md")), "the Herder run's goal");
	checkEqual(run.plan, read(join(runDir, "plan.md")), "the Herder run's plan");
	const step = run.steps.find((item) => item.sessionId === stepId);
	check(step, `the Herder run view lists no step with session ${stepId}: ${JSON.stringify(run.steps)}`);
	checkEqual({ role: step.role, status: step.status }, { role: "explorer", status: "ok" }, "the Herder step");
	log(`links: subagent → Agent call ${AGENT_CALL_ID}, step ${step.key} → session ${stepId} in run ${runId}`);
}

/**
 * The main session has one turn per user prompt plus one for the `/herder` prompt, and the subagent notice steered
 * between a tool result and the next model call stays inside the turn it interrupts.
 */
async function checkTurns(api: ReadApi, mainId: string, mainFile: string): Promise<void> {
	const entries = lines(mainFile);
	const role = (entry: Record<string, unknown> | undefined) => (entry?.message as { role?: string } | undefined)?.role;
	const users = entries.filter((entry) => entry.type === "message" && role(entry) === "user").length;
	const turns = (await api.get<{ items: Turn[] }>(`sessions/${mainId}/turns?limit=1000`))?.items ?? [];
	checkEqual(turns.length, users + 1, "the main session's turns: one per user prompt plus one for the /herder prompt");
	const prompts = [PROMPTS.inspect, PROMPTS.delegate, PROMPTS.herder, PROMPTS.offline, PROMPTS.resumed, PROMPTS.online, PROMPTS.local];
	checkEqual(turns.length, prompts.length, "the main session's turn count");
	for (const [index, prompt] of prompts.entries()) {
		const userText = turns[index]!.userText;
		check(prompt === PROMPTS.herder ? userText.startsWith("/herder: run ") : userText.includes(prompt), `turn ${index} starts at ${JSON.stringify(userText.slice(0, 60))}, not the prompt ${JSON.stringify(prompt)}`);
	}

	const seq = entries.findIndex((entry) => entry.type === "custom_message" && entry.customType === NOTICE_TYPE && entry.display === true);
	check(seq > 0, "the main session has no displayed subagent notice");
	checkEqual(entries.filter((entry) => entry.customType === NOTICE_TYPE).length, 1, "subagent notices in the main session");
	const before = entries[seq - 1]?.message as { role?: string; toolCallId?: string } | undefined;
	checkEqual({ before: before?.role, call: before?.toolCallId, after: role(entries[seq + 1]) }, { before: "toolResult", call: NOTICE_AFTER_CALL_ID, after: "assistant" },
		"the subagent notice's neighbours: it was delivered between a tool result and the next model call");
	const turn = turns.find((item) => item.startSeq <= seq && seq <= item.endSeq);
	check(turn, `no turn covers the notice at seq ${seq}`);
	checkEqual({ index: turn.index, modelCalls: turn.modelCalls, toolCalls: turn.toolCalls, finalText: turn.finalText },
		{ index: 0, modelCalls: 4, toolCalls: 3, finalText: "The data lists the crystals, and I fixed the typo in notes.md." },
		"the turn the subagent notice interrupts");
	log(`turns: ${turns.length} for ${users} user prompts and /herder; the notice at seq ${seq} stays in turn 0`);
}

try {
	await main();
	log("passed");
	process.exit(0);
} catch (error) {
	process.stderr.write(`e2e: FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
}
