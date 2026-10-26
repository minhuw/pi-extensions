// Derives the Herder run view from the journal events in `GET herder/runs/:id`.
import type { RunDetail, RunEvent, RunStep } from "../lib/types";

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The event's fields, whether `data` holds the whole journal line or only its payload. */
export function eventFields(event: RunEvent): Rec {
	return { ...(isRecord(event.data) ? event.data : {}), t: event.t, at: event.at };
}

export interface CheckRun {
	id: string;
	passed: boolean;
	exitCode: number | null;
	timedOut: boolean;
	durationMs?: number;
	tail: string;
	commit?: string;
	purpose?: string;
	key?: string;
	at?: string;
}

/** A Herder `CheckResult` or `check.completed` event. */
export function toCheck(value: unknown, at?: string): CheckRun | undefined {
	if (!isRecord(value)) return undefined;
	const id = str(value.id) ?? str(value.checkId);
	if (!id) return undefined;
	const exitCode = num(value.exitCode) ?? null;
	const timedOut = value.timedOut === true;
	return {
		id,
		passed: typeof value.passed === "boolean" ? value.passed : exitCode === 0 && !timedOut,
		exitCode,
		timedOut,
		durationMs: num(value.durationMs),
		tail: str(value.tail) ?? "",
		commit: str(value.commit),
		purpose: str(value.purpose),
		key: str(value.key),
		at: at ?? str(value.at),
	};
}

function checks(value: unknown): CheckRun[] {
	return Array.isArray(value) ? value.flatMap((item) => toCheck(item) ?? []) : [];
}

export interface StepView extends RunStep {
	launch?: number;
	checks: CheckRun[];
	error?: string;
	durationMs?: number;
}

export interface LaunchGroup {
	launch: number | null;
	at?: string;
	status?: string;
	error?: string;
	reused?: number;
	changed?: number;
	new?: number;
	steps: StepView[];
}

export interface Integration {
	ok: boolean;
	key: string;
	at: string;
	message?: string;
	task?: string;
	head?: string;
	reason?: string;
	conflicts: string[];
	error?: string;
	checks: CheckRun[];
}

export interface Criterion {
	id: string;
	status: string;
	evidence: string;
}

export interface Verification {
	at: string;
	verdict: string;
	head?: string;
	criteria: Criterion[];
	gaps: { kind: string; criteria: string[]; text: string }[];
	checks: CheckRun[];
	verifierRan: boolean;
}

export interface Delivery {
	at: string;
	done: boolean;
	mode?: string;
	target?: string;
	tip?: string;
	commits: string[];
	checks: CheckRun[];
}

export interface RunView {
	sessionId?: string;
	launches: LaunchGroup[];
	checkRuns: CheckRun[];
	integrations: Integration[];
	verification?: Verification;
	decisions: { at: string; question: string; answer: string }[];
	delivery?: Delivery;
	finished?: { status: string; reason: string; at: string };
}

function durationBetween(start?: string, end?: string): number | undefined {
	if (!start || !end) return undefined;
	const ms = Date.parse(end) - Date.parse(start);
	return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

export function buildRunView(detail: RunDetail): RunView {
	const view: RunView = { launches: [], checkRuns: [], integrations: [], decisions: [] };
	const launches = new Map<number, LaunchGroup>();
	const stepLaunch = new Map<string, number>();
	const stepChecks = new Map<string, CheckRun[]>();
	const stepErrors = new Map<string, string>();
	const launchFor = (launch: number) => {
		let group = launches.get(launch);
		if (!group) {
			group = { launch, steps: [] };
			launches.set(launch, group);
		}
		return group;
	};

	for (const event of [...detail.events].sort((a, b) => a.seq - b.seq)) {
		const e = eventFields(event);
		const key = str(e.key);
		switch (event.t) {
			case "run.started":
				view.sessionId = str(e.sessionId);
				break;
			case "script.launched": {
				const launch = num(e.launch);
				if (launch !== undefined) launchFor(launch).at ??= event.at;
				break;
			}
			case "script.settled": {
				const launch = num(e.launch);
				if (launch === undefined) break;
				const group = launchFor(launch);
				Object.assign(group, { status: str(e.status), error: str(e.error), reused: num(e.reused), changed: num(e.changed), new: num(e.new) });
				break;
			}
			case "step.started": {
				const launch = num(e.launch);
				if (key && launch !== undefined && !stepLaunch.has(key)) stepLaunch.set(key, launch);
				break;
			}
			case "step.completed":
				if (key) {
					stepChecks.set(key, checks(e.checks));
					stepErrors.delete(key);
				}
				break;
			case "step.failed":
				if (key) stepErrors.set(key, str(e.message) ?? "failed");
				break;
			case "check.completed": {
				const check = toCheck(e, event.at);
				if (check) view.checkRuns.push(check);
				break;
			}
			case "integrate.completed":
			case "integrate.failed":
				view.integrations.push({
					ok: event.t === "integrate.completed",
					key: key ?? "",
					at: event.at,
					message: str(e.message),
					task: str(e.task),
					head: str(e.head),
					reason: str(e.reason),
					conflicts: Array.isArray(e.conflicts) ? e.conflicts.map(String) : [],
					error: str(e.error),
					checks: checks(e.checks),
				});
				break;
			case "verify.completed":
				view.verification = {
					at: event.at,
					verdict: str(e.verdict) ?? "unknown",
					head: str(e.head),
					criteria: Array.isArray(e.criteria)
						? e.criteria.filter(isRecord).map((c) => ({ id: str(c.id) ?? "?", status: str(c.status) ?? "unknown", evidence: str(c.evidence) ?? "" }))
						: [],
					gaps: Array.isArray(e.gaps)
						? e.gaps.filter(isRecord).map((g) => ({
								kind: str(g.kind) ?? "gap",
								criteria: Array.isArray(g.criteria) ? g.criteria.map(String) : [],
								text: str(g.text) ?? "",
							}))
						: [],
					checks: checks(e.checks),
					verifierRan: e.verifierRan === true,
				};
				break;
			case "decision.recorded":
				view.decisions.push({ at: event.at, question: str(e.question) ?? "", answer: str(e.answer) ?? "" });
				break;
			case "delivery.started":
			case "delivery.completed":
				view.delivery = {
					at: event.at,
					done: event.t === "delivery.completed",
					mode: str(e.mode),
					target: str(e.target),
					tip: str(e.tip),
					commits: Array.isArray(e.commits) ? e.commits.map(String) : [],
					checks: checks(e.checks),
				};
				break;
			case "run.finished":
				view.finished = { status: str(e.status) ?? "", reason: str(e.reason) ?? "", at: event.at };
				break;
		}
	}

	const loose: LaunchGroup = { launch: null, steps: [] };
	for (const step of detail.steps) {
		const launch = stepLaunch.get(step.key);
		const item: StepView = {
			...step,
			launch,
			checks: stepChecks.get(step.key) ?? [],
			error: stepErrors.get(step.key),
			durationMs: durationBetween(step.startedAt, step.endedAt),
		};
		(launch === undefined ? loose : launchFor(launch)).steps.push(item);
	}
	view.launches = [...launches.values()].sort((a, b) => (a.launch ?? 0) - (b.launch ?? 0));
	if (loose.steps.length) view.launches.push(loose);
	return view;
}

export function shortSha(sha: string | undefined): string {
	return sha ? sha.slice(0, 8) : "";
}

export type Tone = "neutral" | "accent" | "red" | "green" | "yellow";

export function runStatusTone(status: string | undefined): Tone {
	switch (status) {
		case "delivered":
		case "completed":
		case "ok":
		case "no_changes":
		case "integrated":
			return "green";
		case "failed":
		case "gate_failed":
		case "error":
			return "red";
		case "running":
		case "started":
		case "active":
			return "accent";
		case "abandoned":
		case "stopped":
			return "neutral";
		default:
			return "neutral";
	}
}

export function verdictTone(verdict: string | undefined): Tone {
	if (verdict === "met") return "green";
	if (verdict === "not_met") return "red";
	if (verdict === "blocked" || verdict === "cant_tell") return "yellow";
	return "neutral";
}

export function label(value: string): string {
	return value.replace(/_/g, " ");
}
