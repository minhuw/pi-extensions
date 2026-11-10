// The self-driving ledger and the report built from it: pure, so tests can check the formatting directly.

export const TASK_STATUSES = ["planned", "running", "proposed", "done", "failed", "dropped"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

/** One ledger task, as the latest `selfdrive-task` entry for its id holds it. */
export interface Task {
	id: string;
	title: string;
	status: TaskStatus;
	why?: string;
	result?: string;
	herderRun?: string;
	needs?: string;
}

/** Each `selfdrive-task` entry holds the whole task after the change; the latest one per id wins, in first-seen order. */
export function foldLedger(entries: readonly Task[]): Task[] {
	const tasks = new Map<string, Task>();
	for (const entry of entries) tasks.set(entry.id, { ...tasks.get(entry.id), ...entry });
	return [...tasks.values()];
}

/** The next free id: T1, T2, … */
export function nextTaskId(tasks: readonly Task[]): string {
	const numbers = tasks.map((task) => Number(/^T(\d+)$/.exec(task.id)?.[1] ?? 0));
	return `T${Math.max(0, ...numbers) + 1}`;
}

/** `13m`, `2h13m`, `7h02m`. */
export function elapsed(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	const hours = Math.floor(minutes / 60);
	return hours ? `${hours}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/** `2 planned, 1 running`, in status order; `none` when empty. */
export function countByStatus(tasks: readonly Task[]): string {
	const counts = TASK_STATUSES.map((status) => [status, tasks.filter((task) => task.status === status).length] as const).filter(([, count]) => count);
	return counts.length ? counts.map(([status, count]) => `${count} ${status}`).join(", ") : "none";
}

export const isOpen = (task: Task) => task.status === "planned" || task.status === "running";

/** Session entries as far as costs go: assistant messages and subagent completion notifications. */
export type CostEntry =
	| { type: "message"; message: { role: string; usage?: { cost?: { total?: number } } } }
	| { type: "custom_message"; customType: string; details?: unknown }
	| { type: string };

/** What the entries cost: the session's own assistant messages, and subagents by their completion notifications. */
export function costOf(entries: readonly CostEntry[]): { cost: number; subagentCost: number } {
	let cost = 0;
	let subagentCost = 0;
	for (const entry of entries) {
		if (entry.type === "message" && "message" in entry && entry.message.role === "assistant") cost += finite(entry.message.usage?.cost?.total);
		if (entry.type === "custom_message" && "customType" in entry && entry.customType === "subagent-notification") {
			subagentCost += finite((entry.details as { totalCost?: unknown } | undefined)?.totalCost);
		}
	}
	return { cost: cost + subagentCost, subagentCost };
}
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

export interface ReportInput {
	tasks: readonly Task[];
	/** ISO times of the mode's start and end; an open mode runs to `now`. */
	since: string;
	ended?: string;
	now?: number;
	/** Driver starts: the kickoff and each continuation, not a count of tasks or model turns. */
	runs: number;
	/** Everything, subagents included. */
	cost: number;
	subagentCost: number;
	/** Why driving stopped, when it did: selfdrive_next done or a runaway guard. */
	doneReason?: string;
}

const money = (value: number) => `$${value.toFixed(2)}`;
const line = (...parts: (string | undefined)[]) => parts.filter((part) => part?.trim()).join(" · ");

/** The report's lines, the first one its header. */
export function buildReport(input: ReportInput): string[] {
	const end = input.ended ? Date.parse(input.ended) : input.now ?? Date.now();
	const proposals = input.tasks.filter((task) => task.status === "proposed").length;
	const header = line(
		"🚗 Self-driving report",
		elapsed(end - Date.parse(input.since)),
		`${input.tasks.length} ${input.tasks.length === 1 ? "task" : "tasks"}`,
		proposals ? `${proposals} ${proposals === 1 ? "proposal" : "proposals"}` : undefined,
		money(input.cost) + (input.subagentCost > 0 ? ` (subagents ${money(input.subagentCost)})` : ""),
	);
	const lines = [header];
	if (input.doneReason) lines.push(`Stopped: ${input.doneReason}`);
	const section = (title: string, tasks: Task[], format: (task: Task) => string) => {
		if (tasks.length) lines.push(`${title}:`, ...tasks.map((task) => `  ${format(task)}`));
	};
	const needsYou = (task: Task) => task.status === "proposed" || !!task.needs;
	section("Needs you", input.tasks.filter(needsYou), (task) => line(`${task.id} ${task.title}`, task.result, task.needs && `needs: ${task.needs}`, task.herderRun && `/herder deliver ${task.herderRun}`));
	const rest = input.tasks.filter((task) => !needsYou(task));
	section("Done", rest.filter((task) => task.status === "done"), (task) => line(`${task.id} ${task.title}`, task.result, task.herderRun && `Herder run ${task.herderRun}`));
	section("Failed", rest.filter((task) => task.status === "failed"), (task) => line(`${task.id} ${task.title}`, task.result ?? task.why, task.herderRun && `Herder run ${task.herderRun}`));
	const inline = (title: string, tasks: Task[], note: (task: Task) => string | undefined) => {
		if (tasks.length) lines.push(`${title}: ${tasks.map((task) => `${task.id} ${task.title}${note(task) ? ` (${note(task)})` : ""}`).join(", ")}`);
	};
	inline("Not done", rest.filter((task) => task.status === "dropped"), (task) => task.result ?? task.why);
	inline("Still open", rest.filter(isOpen), (task) => task.status);
	return lines;
}
