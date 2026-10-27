// The trajectory view end to end: `GET sessions/:id/trace` against what pi wrote, and the session page's trajectory
// (KPI strip, canvas overview, ledger, inspector, lazy subagents, deep links, replay) in the locally installed Chrome.
import { gunzipSync } from "node:zlib";
import { allEntries, type ReadApi } from "./api.ts";
import type { Ui } from "./browser.ts";
import { EDGE_LONG_TOOL, EDGE_MCP_TOOL, LARGE_ENTRIES, LARGE_TURNS } from "./large.ts";
import { AGENT_CALL_ID } from "./scenario.ts";
import { check, checkEqual, log, sleep, waitFor } from "./util.ts";

/** Entry rows rendered in the DOM must stay below this for a 5,000-entry session. */
export const MAX_ENTRY_NODES = 300;
/** The 5,000-entry session's trajectory must render within this long of its trace arriving. */
const LARGE_RENDER_MS = 1_000;

export interface TraceTool {
	kind: "tool";
	seq: number;
	resultSeq?: number;
	turn?: number;
	callId: string;
	name?: string;
	start?: number;
	end?: number;
	durationMs?: number;
	isError: boolean;
	summary: string;
	outputSize?: number;
	childSessionId?: string;
}

export interface TraceLlm {
	kind: "llm";
	seq: number;
	turn?: number;
	start?: number;
	end?: number;
	model?: string;
	requestId?: string;
	text?: string;
	toolCalls: number;
}

export interface Trace {
	sessionId: string;
	startedAt?: number;
	lastAt?: number;
	turns: { index: number; startSeq: number; endSeq: number; at?: number; userText: string; modelCalls: number; toolCalls: number }[];
	records: (TraceTool | TraceLlm | { kind: "compaction" | "branch-summary"; seq: number })[];
	children: { sessionId: string; parentToolCallId?: string; agentType?: string; description?: string; kind: string }[];
}

/** What the browser checks need to find in the main session's trajectory. */
export interface TrajectoryTargets {
	/** The first bash call, `cat data.txt && ls`, whose result holds the search word. */
	bash: TraceTool;
	/** The first model call, which saw the first prompt. */
	llmSeq: number;
	agent: TraceTool;
	tools: TraceTool[];
	llmCount: number;
	turnCount: number;
	/** Distinct `data-kind`s the main session's ledger rows carry. */
	kinds: string[];
}

/** The ledger's `data-kind` of a tool, by the brief's palette: shell, read, write, agent, other. */
export function familyOf(name: string): string {
	const base = name.toLowerCase();
	if (["bash", "shell", "powershell", "sh", "zsh"].includes(base)) return "shell";
	if (["read", "grep", "find", "ls", "glob", "web_fetch", "web_search"].includes(base)) return "read";
	if (["edit", "write", "apply_patch", "codemode"].includes(base)) return "write";
	if (["agent", "subagentworkflow"].includes(base)) return "agent";
	return "other";
}

type Message = { role?: string; content?: unknown; toolCallId?: string };
type Block = { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };

/**
 * The trace of `sessionId` names one tool record per tool call pi wrote, at its assistant entry's seq, with its result's
 * seq, in order, and one model call per assistant entry with its request id.
 */
async function checkAgainstEntries(api: ReadApi, sessionId: string, trace: Trace, label: string): Promise<TraceTool[]> {
	const entries = (await allEntries(api, sessionId)) ?? [];
	const calls: { seq: number; callId: string; name: string; args: Record<string, unknown> }[] = [];
	const results = new Map<string, number>();
	const llm: { seq: number; requestId?: string }[] = [];
	for (const entry of entries) {
		const message = entry.raw.message as Message | undefined;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "assistant") {
			llm.push({ seq: entry.seq, requestId: entry.requestId });
			for (const block of Array.isArray(message.content) ? (message.content as Block[]) : []) {
				if (block.type === "toolCall") calls.push({ seq: entry.seq, callId: block.id!, name: block.name!, args: block.arguments ?? {} });
			}
		}
		if (message.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, entry.seq);
	}
	const tools = trace.records.filter((record): record is TraceTool => record.kind === "tool");
	checkEqual(
		tools.map(({ seq, resultSeq, callId, name }) => ({ seq, resultSeq, callId, name })),
		calls.map(({ seq, callId, name }) => ({ seq, resultSeq: results.get(callId), callId, name })),
		`${label}: the trace's tool records against the tool calls pi wrote`,
	);
	checkEqual(
		trace.records.filter((record): record is TraceLlm => record.kind === "llm").map(({ seq, requestId }) => ({ seq, requestId })),
		llm,
		`${label}: the trace's model calls against the assistant entries`,
	);
	const seqs = trace.records.map((record) => record.seq);
	checkEqual(seqs, [...seqs].sort((a, b) => a - b), `${label}: trace records sorted by seq`);
	for (const record of trace.records) {
		if (record.kind !== "llm" && record.kind !== "tool") continue;
		const { start, end } = record;
		check(start === undefined || (Number.isInteger(start) && start > 1e12), `${label}: seq ${record.seq} starts at ${start}, not epoch ms`);
		check(start === undefined || end === undefined || end >= start, `${label}: seq ${record.seq} ends before it starts`);
	}
	return tools;
}

/**
 * `GET sessions/:id/trace` for the main session, its subagent, and the 5,000-entry session: the tool records match the
 * calls the driver scripted, the subagent maps to the Agent call, the route gzips, and an unknown session is 404.
 */
export async function checkTrace(api: ReadApi, ids: { mainId: string; childId: string; stepId: string; largeId: string }): Promise<TrajectoryTargets> {
	const { mainId, childId, stepId, largeId } = ids;
	const get = async (id: string) => {
		const trace = await api.get<Trace>(`sessions/${encodeURIComponent(id)}/trace`);
		check(trace, `GET sessions/${id}/trace answered 404`);
		checkEqual(trace.sessionId, id, "the trace's sessionId");
		return trace;
	};
	const main = await get(mainId);
	const tools = await checkAgainstEntries(api, mainId, main, "main session");
	const byCall = new Map(tools.map((tool) => [tool.callId, tool]));
	const expected: [string, string, string][] = [
		["call_bash_1", "bash", "cat data.txt && ls"],
		["call_read_1", "read", "notes.md"],
		["call_edit_1", "edit", "notes.md"],
		[AGENT_CALL_ID, "Agent", "worker: Summarize the README"],
		["call_offline", "bash", "echo offline check"],
	];
	for (const [callId, name, summary] of expected) {
		const tool = byCall.get(callId);
		checkEqual({ name: tool?.name, summary: tool?.summary, isError: tool?.isError }, { name, summary, isError: false }, `the trace's ${callId}`);
		check(tool!.start !== undefined && tool!.end !== undefined && tool!.end >= tool!.start, `the trace's ${callId} has no timing: ${JSON.stringify(tool)}`);
	}
	checkEqual(main.turns.length, 7, "the trace's turns of the main session");
	check(main.startedAt !== undefined && main.lastAt !== undefined && main.lastAt >= main.startedAt, `the main trace's bounds ${main.startedAt}..${main.lastAt}`);

	const agent = byCall.get(AGENT_CALL_ID)!;
	checkEqual(agent.childSessionId, childId, "the Agent call's child session in the trace");
	const child = main.children.find((item) => item.sessionId === childId);
	checkEqual({ call: child?.parentToolCallId, kind: child?.kind, agentType: child?.agentType, description: child?.description },
		{ call: AGENT_CALL_ID, kind: "subagent", agentType: "worker", description: "Summarize the README" }, "the trace's subagent child");
	checkEqual(main.children.find((item) => item.sessionId === stepId)?.kind, "herder-step", "the trace's Herder step child");

	const childTrace = await get(childId);
	const childTools = await checkAgainstEntries(api, childId, childTrace, "subagent");
	checkEqual(childTools.map((tool) => [tool.callId, tool.name, tool.summary]), [["call_child_read", "read", "README.md"], ["call_child_bash", "bash", "wc -l README.md"]], "the subagent's trace");

	// Gzipped when the client accepts it, plain otherwise.
	const path = `${api.base}/api/v1/sessions/${encodeURIComponent(largeId)}/trace`;
	const cookie = (api as unknown as { cookie: string }).cookie;
	const plain = await fetch(path, { headers: { cookie, "accept-encoding": "identity" } });
	checkEqual({ status: plain.status, encoding: plain.headers.get("content-encoding") }, { status: 200, encoding: null }, "the large trace without gzip");
	const rawBytes = Buffer.from(await plain.arrayBuffer());
	const zipped = await import("node:http").then(
		({ get }) =>
			new Promise<{ encoding?: string; body: Buffer }>((resolve, reject) => {
				get(path, { headers: { cookie, "accept-encoding": "gzip" } }, (response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("end", () => resolve({ encoding: response.headers["content-encoding"], body: Buffer.concat(chunks) }));
					response.on("error", reject);
				}).on("error", reject);
			}),
	);
	checkEqual(zipped.encoding, "gzip", "the large trace's content-encoding when the client accepts gzip");
	check(gunzipSync(zipped.body).equals(rawBytes), "the gzipped trace differs from the plain one");
	const large = JSON.parse(rawBytes.toString("utf8")) as Trace;
	const perTurn = LARGE_ENTRIES / LARGE_TURNS;
	checkEqual({ turns: large.turns.length, records: large.records.length }, { turns: LARGE_TURNS, records: LARGE_TURNS * (perTurn - 1) }, "the large session's trace");
	log(`trace: large session ${large.records.length} records, ${rawBytes.length} bytes raw, ${zipped.body.length} gzipped`);

	const missing = await api.raw("sessions/00000000-0000-0000-0000-000000000000/trace");
	checkEqual(missing.status, 404, "the trace of an unknown session");
	const anonymous = await fetch(`${api.base}/api/v1/sessions/${encodeURIComponent(mainId)}/trace`);
	checkEqual(anonymous.status, 401, "the trace without a session cookie");

	const kinds = [...new Set(["llm", ...tools.map((tool) => familyOf(tool.name ?? ""))])].sort();
	log(`trace: ${tools.length} tool records match pi's tool calls; ${expected.map(([id]) => id).join(", ")} summarized; ${AGENT_CALL_ID} → ${childId}`);
	return {
		bash: byCall.get("call_bash_1")!,
		llmSeq: main.records.find((record) => record.kind === "llm")!.seq,
		agent,
		tools,
		llmCount: main.records.filter((record) => record.kind === "llm").length,
		turnCount: main.turns.length,
		kinds,
	};
}

const row = (selector: string) => `[data-trajectory] [data-ledger-row]${selector}`;
const toolRow = (seq: number) => row(`[data-record='tool'][data-seq='${seq}']`);
const llmRow = (seq: number) => row(`[data-record='llm'][data-seq='${seq}']`);
const LEDGER_PANE = "[data-trajectory] [data-ledger] [data-scroll-pane]";

/** Opens a session's trajectory and waits for its ledger. */
async function openTrajectory(ui: Ui, sessionId: string, query = ""): Promise<void> {
	await ui.go(`/s/${encodeURIComponent(sessionId)}?view=trajectory${query}`);
	await ui.visible("[data-trajectory] [data-ledger-row]");
}

/** Pixels of the overview's base canvas that are drawn on, and how many distinct colors they use. */
async function canvasInk(ui: Ui): Promise<{ painted: number; colors: number; width: number; height: number }> {
	return ui.page.$eval("[data-overview] canvas", (node) => {
		const canvas = node as HTMLCanvasElement;
		const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
		let painted = 0;
		const colors = new Set<number>();
		for (let i = 0; i < data.length; i += 4) {
			if (data[i + 3]! < 16) continue;
			painted++;
			colors.add(((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4));
		}
		return { painted, colors: colors.size, width: canvas.width, height: canvas.height };
	});
}

/** Every ledger row from top to bottom, scrolling the virtualized ledger: its kind, record type, seq, and turn. */
async function ledgerRows(ui: Ui): Promise<{ kind: string; record: string; seq: number; turn?: number; depth: number }[]> {
	const seen = new Map<string, { kind: string; record: string; seq: number; turn?: number; depth: number; top: number }>();
	await ui.page.$eval(LEDGER_PANE, (pane) => { pane.scrollTop = 0; });
	for (let i = 0; i < 200; i++) {
		await sleep(80);
		const batch = await ui.page.$$eval("[data-trajectory] [data-ledger-row]", (nodes) => nodes.map((node) => ({
			id: node.id,
			kind: node.getAttribute("data-kind") ?? "",
			record: node.getAttribute("data-record") ?? "",
			seq: Number(node.getAttribute("data-seq")),
			turn: node.hasAttribute("data-turn-index") ? Number(node.getAttribute("data-turn-index")) : undefined,
			depth: Number(node.getAttribute("data-depth") ?? 0),
			top: Number((node.parentElement as HTMLElement).getAttribute("data-index")),
		})));
		for (const { id, ...rest } of batch) seen.set(id, rest);
		const done = await ui.page.$eval(LEDGER_PANE, (pane) => {
			const end = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
			pane.scrollTop += pane.clientHeight * 0.8;
			return end;
		});
		if (done) break;
	}
	await ui.page.$eval(LEDGER_PANE, (pane) => { pane.scrollTop = 0; });
	return [...seen.values()].sort((a, b) => a.top - b.top).map(({ top: _, ...rest }) => rest);
}

/** Resource URLs the page fetched, for the lazy loading checks. */
const fetched = (ui: Ui) => ui.page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));

/** The trajectory of the main session, in the theme `ui.theme`; `full` runs every check, otherwise only screenshots. */
export async function checkTrajectory(ui: Ui, t: { mainId: string; childId: string; firstPrompt: string; searchWord: string; trace: TrajectoryTargets }, full: boolean): Promise<void> {
	const { page, shot, visible, click, textOf, count } = ui;
	const { bash, agent, llmSeq } = t.trace;
	await openTrajectory(ui, t.mainId);
	await visible("[data-trajectory] [data-overview] canvas");

	if (full) {
		// The KPI strip counts what the trace holds.
		const kpi = async (name: string) => (await textOf(`[data-kpi='${name}'] [data-kpi-value]`)).trim();
		checkEqual(
			{ turns: await kpi("turns"), llm: await kpi("llm"), tools: await kpi("tools"), subagents: await kpi("subagents") },
			{ turns: String(t.trace.turnCount), llm: String(t.trace.llmCount), tools: String(t.trace.tools.length), subagents: "2" },
			"the KPI strip",
		);
		for (const name of ["tokens", "cost", "context"]) check((await kpi(name)) !== "", `the ${name} KPI is empty`);

		// The overview's canvas is drawn on, in more than one color.
		const ink = await waitFor(async () => {
			const value = await canvasInk(ui);
			return value.painted > 500 && value.colors >= 4 ? value : undefined;
		}, 5_000, "the overview canvas to be drawn");
		log(`trajectory: the overview canvas (${ink.width}×${ink.height}) has ${ink.painted} painted pixels in ${ink.colors} colors`);
		const label = await page.$eval("[data-overview]", (node) => node.getAttribute("aria-label") ?? "");
		check(label.includes(`${t.trace.turnCount} turns`), `the overview's text alternative says ${JSON.stringify(label)}`);

		// One ledger row per record, tools in pi's order with their family as data-kind.
		const rows = await ledgerRows(ui);
		const tools = rows.filter((item) => item.record === "tool" && item.depth === 0);
		checkEqual(
			tools.map(({ kind, seq }) => ({ kind, seq })),
			t.trace.tools.map((tool) => ({ kind: familyOf(tool.name ?? ""), seq: tool.seq })),
			"the ledger's tool rows",
		);
		checkEqual(rows.filter((item) => item.record === "llm").length, t.trace.llmCount, "the ledger's model call rows");
		checkEqual([...new Set(rows.map((item) => item.kind))].sort(), t.trace.kinds, "the ledger rows' kinds");
		check(rows.every((item) => item.record !== "tool" || item.turn !== undefined), "a ledger row lacks data-turn-index");
		log(`trajectory: ${rows.length} ledger rows with kinds ${t.trace.kinds.join(", ")}`);
	}

	// A live session opens at its tail, so bring the first turn's bash row into view first.
	await page.$eval(LEDGER_PANE, (pane) => { pane.scrollTop = 0; });
	await visible(toolRow(bash.seq));
	// A bash row opens the inspector on its command and output.
	await click(toolRow(bash.seq));
	await visible(`${toolRow(bash.seq)}[data-selected]`);
	await click("[data-inspector] [data-tab-button='rendered']");
	await visible("[data-inspector][data-tab='rendered'] [data-tool='bash']");
	await waitFor(async () => (await textOf("[data-inspector] [data-tool='bash']")).includes(t.searchWord), 5_000, "the bash output in the inspector");
	check((await textOf("[data-inspector]")).includes("cat data.txt && ls"), "the inspector does not show the bash command");
	await shot("16-trajectory");
	if (full) {
		// The inspector loads only the entries it shows.
		const entries = (await fetched(ui)).filter((url) => url.includes(`/sessions/${t.mainId}/entries`));
		check(entries.length > 0 && entries.every((url) => /[?&]limit=1(&|$)/.test(url)), `the trajectory fetched entries beyond one at a time: ${entries.join(" ")}`);
		await click("[data-inspector] [data-tab-button='input']");
		await visible("[data-inspector][data-tab='input']");
		check((await textOf("[data-inspector]")).includes("cat data.txt && ls"), "the Input tab does not show the command");
		await click("[data-inspector] [data-tab-button='output']");
		await waitFor(async () => (await textOf("[data-inspector][data-tab='output']")).includes(t.searchWord), 5_000, "the Output tab's result");
		log("trajectory: the bash row's inspector shows its command and output");
	}

	// What the model saw, for the first model call.
	await click(llmRow(llmSeq));
	await click("[data-inspector] [data-tab-button='context']");
	await visible("[data-inspector][data-tab='context'] [data-context-panel] [data-system-sections]");
	await visible("[data-inspector][data-tab='context'] [data-context-message]");
	const context = await textOf("[data-inspector]");
	check(context.includes("System prompt") && context.includes("Messages"), "the Context tab has no system prompt or messages section");
	check(context.includes(t.firstPrompt.slice(0, 30)), "the Context tab does not show the user's message");
	await shot("17-trajectory-context");
	await click("[data-inspector] [data-tab-button='rendered']");
	if (full) log("trajectory: the Context tab shows what the model saw");

	// The subagent row loads the child's trace only when it is expanded.
	const childTrace = `/sessions/${t.childId}/trace`;
	if (full) check(!(await fetched(ui)).some((url) => url.includes(childTrace)), "the trajectory loaded the subagent's trace before it was expanded");
	await click(`${toolRow(agent.seq)} button[aria-label='Expand subagent']`);
	await visible(row("[data-depth='1'][data-kind='read']"));
	await visible(row("[data-depth='1'][data-kind='shell']"));
	if (full) {
		check((await fetched(ui)).some((url) => url.includes(childTrace)), "the expanded subagent's trace was not fetched");
		checkEqual(await count(row("[data-depth='1'][data-record='tool']")), 2, "the expanded subagent's tool rows");
	}
	await click(row("[data-depth='1'][data-kind='read']"));
	await waitFor(async () => (await textOf("[data-inspector]")).includes("README.md"), 5_000, "the subagent's read in the inspector");
	await shot("18-trajectory-subagent");
	if (full) log("trajectory: the subagent row expands lazily to the child's records");
}

/** A `?seq=` deep link selects its record; the view switch persists across reloads; replay moves the playhead. */
export async function checkTrajectoryNavigation(ui: Ui, t: { mainId: string; searchSeq: number; searchWord: string; trace: TrajectoryTargets }, full: boolean): Promise<void> {
	const { page, shot, visible, click, textOf } = ui;
	if (full) {
		// The search hit is the bash result: the deep link selects its tool row and shows the output.
		await openTrajectory(ui, t.mainId, `&seq=${t.searchSeq}`);
		await visible(`${toolRow(t.trace.bash.seq)}[data-selected]`);
		await waitFor(async () => (await textOf("[data-inspector]")).includes(t.searchWord), 5_000, "the deep-linked record's output in the inspector");
		await waitFor(() => !new URL(page.url()).searchParams.has("seq"), 5_000, "the handled seq to leave the URL");
		log(`trajectory: ?seq=${t.searchSeq} selects the bash call at seq ${t.trace.bash.seq}`);

		// The view switch goes into the URL and is remembered across reloads and plain links.
		await click("[data-view-switch] [data-view='transcript']");
		await visible("[data-session-page='transcript'] [data-turn-list]");
		checkEqual(new URL(page.url()).searchParams.get("view"), "transcript", "the URL's view after switching");
		await page.reload({ waitUntil: "networkidle0" });
		await visible("[data-session-page='transcript'] [data-turn-list]");
		await ui.go(`/s/${encodeURIComponent(t.mainId)}`);
		await visible("[data-session-page='transcript'] [data-turn-list]");
		await click("[data-view-switch] [data-view='trajectory']");
		await visible("[data-trajectory] [data-ledger-row]");
		await ui.go(`/s/${encodeURIComponent(t.mainId)}`);
		await visible("[data-trajectory] [data-ledger-row]");
		log("trajectory: the view switch persists across reloads");
	}

	// Replay at 1× sweeps the playhead and follows it in the ledger.
	await openTrajectory(ui, t.mainId);
	await click("[data-replay] [data-speed='1']");
	await click("[data-replay-toggle]");
	await visible("[data-replay][data-status='playing']");
	const playhead = () => page.$eval("[data-playhead]", (node) => (node as HTMLElement).getBoundingClientRect().left).catch(() => undefined);
	const first = await waitFor(playhead, 5_000, "the playhead");
	await waitFor(async () => ((await playhead()) ?? first) > first + 8, 10_000, "the playhead to move");
	await visible("[data-ledger-row][data-replay-current]");
	await click("[data-replay-toggle]");
	await visible("[data-replay][data-status='paused']");
	await shot("19-trajectory-replay");
	await page.keyboard.press("Escape");
	await visible("[data-replay][data-status='stopped']");
	check((await page.$("[data-playhead]")) === null, "the playhead stays after Esc stopped the replay");
	if (full) log("trajectory: replay moves the playhead and follows it in the ledger");
}

/** The 5,000-entry session's trajectory renders quickly and keeps fewer than `MAX_ENTRY_NODES` entry nodes. */
export async function checkLargeTrajectory(ui: Ui, largeId: string, full: boolean): Promise<void> {
	const { page, shot, count } = ui;
	// Notes when the first ledger rows enter the DOM, in the page's own clock (0 is the navigation's start).
	const probe = full
		? await page.evaluateOnNewDocument(() => {
			const observer = new MutationObserver(() => {
				if (!document.querySelector("[data-ledger-row]")) return;
				(window as unknown as { pikaLedgerAt: number }).pikaLedgerAt = performance.now();
				observer.disconnect();
			});
			observer.observe(document, { childList: true, subtree: true });
		})
		: undefined;
	try {
		await openTrajectory(ui, largeId);
	} finally {
		if (probe) await page.removeScriptToEvaluateOnNewDocument(probe.identifier);
	}
	if (full) {
		// From the trace's arrival to the first ledger rows: the time the page takes to render it.
		const timing = await page.evaluate((id) => {
			const trace = performance.getEntriesByType("resource").find((entry) => entry.name.includes(`/sessions/${id}/trace`)) as PerformanceResourceTiming | undefined;
			return { traceStart: trace?.startTime, traceEnd: trace?.responseEnd, rows: (window as unknown as { pikaLedgerAt?: number }).pikaLedgerAt };
		}, largeId);
		check(timing.traceEnd !== undefined && timing.traceStart !== undefined && timing.rows !== undefined, `the large trajectory's timings are incomplete: ${JSON.stringify(timing)}`);
		const render = timing.rows - timing.traceEnd;
		check(render < LARGE_RENDER_MS, `the large trajectory rendered ${Math.round(render)} ms after its trace arrived`);
		check(timing.rows < LARGE_RENDER_MS * 2, `the large trajectory showed its first rows ${Math.round(timing.rows)} ms after navigation`);
		log(`trajectory: the large session's trace took ${Math.round(timing.traceEnd - timing.traceStart)} ms, rendering it ${Math.round(render)} ms; rows ${Math.round(timing.rows)} ms after navigation`);
	}
	const nodes = () => count("[data-turn], [data-entry-seq]");
	const top = await nodes();
	check(top > 0 && top < MAX_ENTRY_NODES, `${top} entry nodes in the DOM at the top of the large trajectory`);
	await shot("20-trajectory-large");
	if (!full) return;
	let most = top;
	await waitFor(async () => {
		await page.$eval(LEDGER_PANE, (pane) => { pane.scrollTop += pane.clientHeight * 3; });
		await sleep(60);
		most = Math.max(most, await nodes());
		check(most < MAX_ENTRY_NODES, `${most} entry nodes in the DOM while scrolling the large trajectory`);
		return page.$eval(LEDGER_PANE, (pane) => pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2);
	}, 60_000, "the end of the large trajectory's ledger", 20);
	check((await count(`[data-ledger-row][data-turn-index='${LARGE_TURNS - 1}']`)) > 0, "the end of the large ledger shows no row of the last turn");
	log(`trajectory: the large session keeps ${top} entry nodes at the top and at most ${most} while scrolling`);
}

/**
 * The edge session's trace keeps long summaries to 160 characters, marks the failed command, keeps the compaction,
 * and omits what pi did not record: model calls without `durationMs` end at their entry's time. The chat has no tools.
 */
export async function checkEdgeTraces(api: ReadApi, ids: { edgeId: string; chatId: string }): Promise<void> {
	const edge = await api.get<Trace>(`sessions/${ids.edgeId}/trace`);
	check(edge, "the edge session has no trace");
	const tools = edge.records.filter((record): record is TraceTool => record.kind === "tool");
	checkEqual(tools.map((tool) => [tool.callId, tool.name, tool.isError]), [
		["call_mcp", EDGE_MCP_TOOL, false], ["call_long", "bash", true], ["call_custom", EDGE_LONG_TOOL, false], ["call_script", "bash", false],
	], "the edge session's tool records");
	checkEqual(tools.map((tool) => [...tool.summary].length), [24, 160, 160, 29], "the edge session's summary lengths");
	checkEqual(edge.records.filter((record) => record.kind === "compaction").length, 1, "the edge session's compactions");
	const llm = edge.records.filter((record): record is TraceLlm => record.kind === "llm");
	check(llm[0]!.start !== undefined && llm[0]!.start === llm[0]!.end, `a model call without durationMs ends at ${llm[0]!.end}, not at its entry's time ${llm[0]!.start}`);
	checkEqual(llm.at(-1)!.end! - llm.at(-1)!.start!, 2_100, "a model call's span from its durationMs");
	const chat = await api.get<Trace>(`sessions/${ids.chatId}/trace`);
	checkEqual({ tools: chat?.records.filter((record) => record.kind === "tool").length, llm: chat?.records.length, turns: chat?.turns.length }, { tools: 0, llm: 2, turns: 2 }, "the chat session's trace");
	log("trace: the edge session's summaries, failure, compaction, and missing timings; the chat has no tools");
}

/** The edge session's failed long command in the inspector, and the session without tools. */
export async function checkEdgeTrajectories(ui: Ui, t: { edgeId: string; chatId: string }, full: boolean): Promise<void> {
	const { shot, visible, click, textOf, count, page } = ui;
	await openTrajectory(ui, t.edgeId);
	const failed = row("[data-record='tool'][data-error]");
	await click(failed);
	await visible("[data-inspector] [data-tool='bash']");
	await waitFor(async () => (await textOf("[data-inspector]")).includes("ModuleNotFoundError"), 5_000, "the failed command's output in the inspector");
	if (full) {
		checkEqual(await count(row("[data-record='tool'][data-error]")), 1, "failed tool rows in the edge session");
		checkEqual(await count(row("[data-kind='compaction']")), 1, "compaction rows in the edge session");
		checkEqual(await count(row("[data-record='llm'][data-error]")), 1, "errored model call rows in the edge session");
		// Long names and summaries stay inside their row.
		const overflow = await page.$$eval("[data-ledger-row]", (nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).length);
		checkEqual(overflow, 0, "ledger rows wider than the ledger");
	}
	await shot("21-trajectory-edge");
	await openTrajectory(ui, t.chatId);
	if (full) {
		checkEqual(await count(row("[data-record='tool']")), 0, "tool rows in the chat session");
		checkEqual((await textOf("[data-kpi='tools'] [data-kpi-value]")).trim(), "0", "the chat session's tool calls KPI");
	}
	await click(row("[data-record='llm']"));
	await shot("22-trajectory-chat");
	if (full) log("trajectory: the edge session's long names, failure, and compaction, and a session without tools");
}
