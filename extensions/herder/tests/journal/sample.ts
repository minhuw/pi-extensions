import { makeEvent } from "../../src/journal/events.ts";
import type { CheckResult, JournalEvent, JournalInput } from "../../src/types.ts";

export function journalOf(inputs: JournalInput[]): JournalEvent[] {
	return inputs.map((input, index) => makeEvent(input, new Date(Date.UTC(2026, 0, 1, 0, 0, index))));
}

export const check = (id: string, passed: boolean): CheckResult => ({ id, commit: "c", exitCode: passed ? 0 : 1, timedOut: false, durationMs: 5, tail: "", logRef: "outputs/x.txt", passed });
export const started = (key: string, fingerprint: string, attempt: number, task?: string): JournalInput =>
	({ t: "step.started", key, id: key.replace(/-\d+$/, ""), occurrence: 0, fingerprint, attempt, role: "worker", write: true, base: "b0", task, launch: 1 });

export const sampleJournal = (): JournalEvent[] => journalOf([
	{ t: "run.started", runId: "20260101-000000-abcd", title: "Add | feature", base: "b0", runtime: "0.1.0", repo: "/repo" },
	{ t: "goal.approved", sha256: "g1", checks: [{ id: "unit", command: "npm test", timeoutMs: 1000, integrate: true }], approvedBy: "user" },
	{ t: "plan.updated", sha256: "p1" },
	{ t: "script.launched", launch: 1, scriptSha256: "s1", args: {}, head: "b0" },
	started("impl1-0", "f1", 1, "T1"),
	{ t: "step.completed", key: "impl1-0", fingerprint: "f1", status: "ok", commit: "c1", ref: "refs/herder/x/steps/impl1-0", checks: [check("unit", true)] },
	started("impl2-0", "f2", 1, "T2"),
	{ t: "step.failed", key: "impl2-0", fingerprint: "f2", attempt: 1, errorClass: "transient", message: "net", final: false },
	started("impl2-0", "f2", 2, "T2"),
	{ t: "step.completed", key: "impl2-0", fingerprint: "f2", status: "gate_failed", commit: "c2", checks: [check("unit", false)] },
	{ t: "check.completed", checkId: "unit", commit: "h1", exitCode: 0, timedOut: false, durationMs: 9, logRef: "outputs/a.txt", tail: "ok", purpose: "integrate" },
	{ t: "integrate.completed", key: "i1", from: "b0", source: "c1", head: "h1", tree: "t1", message: "feat: one", task: "T1", checks: [check("unit", true)] },
	{ t: "integrate.failed", key: "i2", from: "h1", source: "c2", reason: "conflict", conflicts: ["a.txt"], task: "T3" },
	started("rev-0", "f3", 1, "T4"),
	{ t: "script.settled", launch: 1, status: "completed", reused: 0, changed: 0, new: 3 },
	{ t: "decision.recorded", question: "ship?", answer: "yes" },
	{ t: "verify.completed", head: "h1", checks: [check("unit", true)], verdict: "not_met", criteria: [], verifierRan: false },
]);
