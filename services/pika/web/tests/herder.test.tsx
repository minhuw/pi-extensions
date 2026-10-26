import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildRunView } from "../src/herder/run";
import type { RunDetail, RunEvent } from "../src/lib/types";
import { renderApp } from "./support/render";
import { createFakeServer } from "./support/server";

const RUN = "20261020-090000-ab12";
const COMMIT_1 = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const COMMIT_2 = "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c";
const HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

function at(minutes: number): string {
	return new Date(Date.parse("2026-10-20T09:00:00.000Z") + minutes * 60_000).toISOString();
}

/** Journal lines as Herder writes them; the API returns each as `{ seq, t, at, data }`. */
function journal(): RunEvent[] {
	const check = (id: string, commit: string, passed: boolean, tail: string) => ({
		id,
		commit,
		exitCode: passed ? 0 : 1,
		timedOut: false,
		durationMs: 42_000,
		tail,
		logRef: `outputs/${id}.txt`,
		passed,
	});
	const lines: Record<string, unknown>[] = [
		{ t: "run.started", runId: RUN, title: "Add pika search", base: "abc", runtime: "herder 1", repo: "pi-extensions", sessionId: "orch-1" },
		{ t: "goal.approved", sha256: "g1", checks: [{ id: "web-tests", command: "npm test", timeoutMs: 600000, integrate: true }], approvedBy: "user" },
		{ t: "plan.updated", sha256: "p1" },
		{ t: "script.launched", launch: 1, scriptSha256: "s1", args: {}, head: "abc" },
		{ t: "step.started", key: "impl-T1#1", id: "impl-T1", occurrence: 1, fingerprint: "f1", attempt: 1, role: "worker", write: true, base: "abc", task: "T1", launch: 1, label: "Build the index", sessionId: "step-s1", sessionFile: "/runs/sessions/s1.jsonl" },
		{ t: "check.completed", checkId: "web-tests", commit: COMMIT_1, exitCode: 0, timedOut: false, durationMs: 42_000, logRef: "outputs/a.txt", tail: "Tests 40 passed", purpose: "gate", key: "impl-T1#1" },
		{ t: "step.completed", key: "impl-T1#1", fingerprint: "f1", status: "ok", commit: COMMIT_1, checks: [check("web-tests", COMMIT_1, true, "Tests 40 passed")], sessionId: "step-s1" },
		{ t: "step.started", key: "impl-T2#1", id: "impl-T2", occurrence: 1, fingerprint: "f2", attempt: 1, role: "worker", write: true, base: "abc", task: "T2", launch: 1, sessionId: "step-s2a" },
		{ t: "step.failed", key: "impl-T2#1", fingerprint: "f2", attempt: 1, errorClass: "transient", message: "rate limited", final: false, sessionId: "step-s2a" },
		{ t: "step.started", key: "impl-T2#1", id: "impl-T2", occurrence: 1, fingerprint: "f2", attempt: 2, role: "worker", write: true, base: "abc", task: "T2", launch: 1, sessionId: "step-s2" },
		{ t: "check.completed", checkId: "web-tests", commit: COMMIT_2, exitCode: 1, timedOut: false, durationMs: 40_000, logRef: "outputs/b.txt", tail: "1 failed: search.test.tsx", purpose: "gate", key: "impl-T2#1" },
		{ t: "step.completed", key: "impl-T2#1", fingerprint: "f2", status: "gate_failed", commit: COMMIT_2, checks: [check("web-tests", COMMIT_2, false, "1 failed: search.test.tsx")], sessionId: "step-s2" },
		{ t: "integrate.completed", key: "integrate:impl-T1#1", from: "abc", source: COMMIT_1, head: HEAD, tree: "t", message: "feat(pika): build the index", task: "T1", checks: [check("web-tests", HEAD, true, "ok")] },
		{ t: "integrate.failed", key: "integrate:impl-T2#1", from: HEAD, source: COMMIT_2, reason: "conflict", conflicts: ["src/search.ts"], task: "T2" },
		{ t: "script.settled", launch: 1, status: "completed", reused: 0, changed: 0, new: 2 },
		{ t: "script.launched", launch: 2, scriptSha256: "s2", args: {}, head: HEAD, resumes: 1 },
		{ t: "step.started", key: "review#1", id: "review", occurrence: 1, fingerprint: "f3", attempt: 1, role: "reviewer", write: false, base: HEAD, launch: 2, phase: "Review", sessionId: "step-s3" },
		{ t: "step.completed", key: "review#1", fingerprint: "f3", status: "ok", text: "Looks good", sessionId: "step-s3" },
		{ t: "script.settled", launch: 2, status: "completed", reused: 2, changed: 0, new: 1 },
		{
			t: "verify.completed",
			head: HEAD,
			checks: [check("web-tests", HEAD, true, "Tests 52 passed")],
			verdict: "met",
			criteria: [
				{ id: "AC-1", status: "met", evidence: "search.test.tsx covers snippets" },
				{ id: "AC-2", status: "cant_tell", evidence: "needs a browser" },
			],
			verifierRan: true,
		},
		{ t: "decision.recorded", question: "Deliver as a series?", answer: "Yes, one commit per task." },
		{ t: "delivery.started", mode: "series", target: "main", tip: HEAD, onto: "abc", commits: [COMMIT_1, HEAD] },
		{ t: "delivery.completed", mode: "series", target: "main", tip: HEAD, commits: [COMMIT_1, HEAD] },
		{ t: "run.finished", status: "delivered", reason: "delivered to main" },
	];
	return lines.map((line, index) => {
		const data = { v: 1, at: at(index), ...line };
		return { seq: index, t: String(line.t), at: data.at, data };
	});
}

function runDetail(): RunDetail {
	return {
		run: {
			runId: RUN,
			device: "mini",
			repo: "pi-extensions",
			title: "Add pika search",
			status: "delivered",
			verdict: "met",
			startedAt: at(0),
			lastAt: at(95),
			stepCount: 3,
		},
		goal: "## Intent\nShip **search**.",
		plan: "# Plan\n- [ ] T1 build the index",
		events: journal(),
		steps: [
			{ key: "impl-T1#1", id: "impl-T1", task: "T1", role: "worker", label: "Build the index", status: "ok", attempts: 1, sessionId: "step-s1", commit: COMMIT_1, startedAt: at(4), endedAt: at(6) },
			{ key: "impl-T2#1", id: "impl-T2", task: "T2", role: "worker", status: "gate_failed", attempts: 2, sessionId: "step-s2", commit: COMMIT_2, startedAt: at(7), endedAt: at(11) },
			{ key: "review#1", id: "review", role: "reviewer", phase: "Review", status: "ok", attempts: 1, sessionId: "step-s3", startedAt: at(16), endedAt: at(17) },
		],
	};
}

describe("Herder runs", () => {
	it("lists runs with status, verdict, repo, device, and step count", async () => {
		const other = runDetail();
		other.run = { ...other.run, runId: "r-2", title: "Fix the footer", status: "failed", verdict: undefined, stepCount: 1 };
		renderApp("/runs", createFakeServer({ runs: [runDetail(), other] }).fetch);
		const row = (await screen.findByText("Add pika search")).closest<HTMLElement>("[data-run-row]")!;
		expect(row.getAttribute("href")).toBe(`/runs/${RUN}`);
		for (const text of ["delivered", "met", "pi-extensions", "mini", "3 steps"]) expect(within(row).getByText(text)).toBeTruthy();
		const failed = screen.getByText("Fix the footer").closest<HTMLElement>("[data-run-row]")!;
		expect(within(failed).getByText("failed")).toBeTruthy();
		expect(within(failed).getByText("1 step")).toBeTruthy();
	});

	it("shows a run's properties, goal, plan, timeline, checks, integrations, verification, decisions, and delivery", async () => {
		renderApp(`/runs/${RUN}`, createFakeServer({ runs: [runDetail()] }).fetch);
		expect(await screen.findByRole("heading", { name: "Add pika search" })).toBeTruthy();
		for (const label of ["Status", "Verdict", "Repo", "Device", "Started", "Duration"]) {
			expect(screen.getByText(label, { selector: "dt span" })).toBeTruthy();
		}
		expect(screen.getByText("1h 35m")).toBeTruthy();
		expect(screen.getByRole("link", { name: "Orchestrating session" }).getAttribute("href")).toBe("/s/orch-1");

		// Goal and plan are collapsed markdown toggles.
		expect(screen.queryByText("search", { selector: "strong" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Goal" }));
		expect(screen.getByText("search", { selector: "strong" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Plan" }));
		expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();

		// Steps grouped by launch.
		const launch1 = document.querySelector<HTMLElement>("[data-launch='1']")!;
		const launch2 = document.querySelector<HTMLElement>("[data-launch='2']")!;
		expect([...launch1.querySelectorAll("[data-step]")].map((node) => node.getAttribute("data-step"))).toEqual(["impl-T1#1", "impl-T2#1"]);
		expect([...launch2.querySelectorAll("[data-step]")].map((node) => node.getAttribute("data-step"))).toEqual(["review#1"]);
		expect(within(launch1).getByText("2 new · 0 reused · 0 changed")).toBeTruthy();
		const t1 = launch1.querySelector<HTMLElement>("[data-step='impl-T1#1']")!;
		for (const text of ["worker", "Build the index", "ok", "1 attempt", "2m"]) expect(within(t1).getByText(text)).toBeTruthy();
		expect(within(t1).getByTitle(COMMIT_1).textContent).toBe(COMMIT_1.slice(0, 8));
		expect(within(t1).getByRole("link", { name: /Session/ }).getAttribute("href")).toBe("/s/step-s1");
		const t2 = launch1.querySelector<HTMLElement>("[data-step='impl-T2#1']")!;
		expect(within(t2).getByText("gate failed")).toBeTruthy();
		expect(within(t2).getByText("2 attempts")).toBeTruthy();
		expect(within(t2).getByRole("link", { name: /Session/ }).getAttribute("href")).toBe("/s/step-s2");
		expect(t2.querySelector("[data-check='web-tests']")?.getAttribute("data-passed")).toBe("false");
		expect(within(launch2).getByText("Review")).toBeTruthy();

		// Check runs: pass/fail pills with the tail in a toggle.
		const checks = document.querySelector<HTMLElement>("[data-section='checks']")!;
		expect([...checks.querySelectorAll("[data-check]")].map((node) => node.getAttribute("data-passed"))).toEqual(["true", "false"]);
		expect(within(checks).queryByText("1 failed: search.test.tsx")).toBeNull();
		fireEvent.click(within(checks).getAllByRole("button", { name: "Tail" })[1]);
		expect(within(checks).getByText("1 failed: search.test.tsx")).toBeTruthy();

		const integrations = document.querySelector<HTMLElement>("[data-section='integrations']")!;
		expect(within(integrations).getByText("feat(pika): build the index")).toBeTruthy();
		expect(within(integrations).getByText("integrated")).toBeTruthy();
		expect(within(integrations).getByText("conflict")).toBeTruthy();
		expect(within(integrations).getByText("Conflicts: src/search.ts")).toBeTruthy();

		const verification = document.querySelector<HTMLElement>("[data-section='verification']")!;
		expect(within(verification).getByText("met", { selector: "[data-section='verification'] > div > span" })).toBeTruthy();
		expect(within(verification.querySelector<HTMLElement>("[data-criterion='AC-1']")!).getByText("search.test.tsx covers snippets")).toBeTruthy();
		expect(within(verification.querySelector<HTMLElement>("[data-criterion='AC-2']")!).getByText("cant tell")).toBeTruthy();

		const decisions = document.querySelector<HTMLElement>("[data-section='decisions']")!;
		expect(within(decisions).getByText("Deliver as a series?")).toBeTruthy();
		const delivery = document.querySelector<HTMLElement>("[data-section='delivery']")!;
		for (const text of ["delivered", "series", "main", "2 commits", HEAD.slice(0, 8)]) expect(within(delivery).getByText(text)).toBeTruthy();
	});

	it("derives the run view from journal events", () => {
		const view = buildRunView(runDetail());
		expect(view.sessionId).toBe("orch-1");
		expect(view.launches.map((group) => [group.launch, group.status, group.steps.length])).toEqual([
			[1, "completed", 2],
			[2, "completed", 1],
		]);
		expect(view.checkRuns.map((check) => [check.id, check.passed])).toEqual([
			["web-tests", true],
			["web-tests", false],
		]);
		expect(view.integrations.map((item) => item.ok)).toEqual([true, false]);
		expect(view.verification?.criteria.map((criterion) => criterion.status)).toEqual(["met", "cant_tell"]);
		expect(view.delivery?.done).toBe(true);
		expect(view.finished?.status).toBe("delivered");
	});

	it("lists a step retried in a resumed launch under both launches", async () => {
		const lines: Record<string, unknown>[] = [
			{ t: "run.started", runId: "r-3", title: "Retry a step", base: "abc", runtime: "herder 1", repo: "pi-extensions" },
			{ t: "script.launched", launch: 1, scriptSha256: "s1", args: {}, head: "abc" },
			{ t: "step.started", key: "impl-T1-1", id: "impl-T1", occurrence: 1, fingerprint: "f1", attempt: 1, role: "worker", write: true, base: "abc", task: "T1", launch: 1 },
			{ t: "step.failed", key: "impl-T1-1", fingerprint: "f1", attempt: 1, errorClass: "transient", message: "rate limited", final: false, sessionId: "s-a" },
			{ t: "step.started", key: "impl-T1-1", id: "impl-T1", occurrence: 1, fingerprint: "f1", attempt: 2, role: "worker", write: true, base: "abc", task: "T1", launch: 1 },
			{ t: "step.failed", key: "impl-T1-1", fingerprint: "f1", attempt: 2, errorClass: "fatal", message: "worker crashed", final: true, sessionId: "s-b" },
			{ t: "step.started", key: "impl-T2-1", id: "impl-T2", occurrence: 1, fingerprint: "f2", attempt: 1, role: "worker", write: true, base: "abc", task: "T2", launch: 1 },
			{ t: "step.completed", key: "impl-T2-1", fingerprint: "f2", status: "ok", commit: COMMIT_2, sessionId: "s-c" },
			{ t: "script.settled", launch: 1, status: "failed", reused: 0, changed: 0, new: 2, error: "impl-T1 failed" },
			{ t: "script.launched", launch: 2, scriptSha256: "s1", args: {}, head: "abc", resumes: 1 },
			{ t: "step.started", key: "impl-T1-1", id: "impl-T1", occurrence: 1, fingerprint: "f1", attempt: 1, role: "worker", write: true, base: "abc", task: "T1", launch: 2 },
			{ t: "step.completed", key: "impl-T1-1", fingerprint: "f1", status: "ok", commit: COMMIT_1, sessionId: "s-d" },
			{ t: "script.settled", launch: 2, status: "completed", reused: 1, changed: 1, new: 0 },
		];
		const events = lines.map((line, index) => ({ seq: index, t: String(line.t), at: at(index), data: { v: 1, at: at(index), ...line } }));
		const detail: RunDetail = {
			run: { runId: "r-3", device: "mini", repo: "pi-extensions", title: "Retry a step", status: "running", startedAt: at(0), lastAt: at(12), stepCount: 2 },
			events,
			// The server's per-key aggregate reflects only the latest launch.
			steps: [
				{ key: "impl-T1-1", id: "impl-T1", task: "T1", role: "worker", status: "ok", attempts: 2, sessionId: "s-d", commit: COMMIT_1, startedAt: at(2), endedAt: at(11) },
				{ key: "impl-T2-1", id: "impl-T2", task: "T2", role: "worker", status: "ok", attempts: 1, sessionId: "s-c", commit: COMMIT_2, startedAt: at(6), endedAt: at(7) },
			],
		};

		const view = buildRunView(detail);
		expect(view.launches.map((group) => [group.launch, group.steps.map((step) => [step.key, step.status, step.attempts, step.sessionId, step.commit, step.error])])).toEqual([
			[
				1,
				[
					["impl-T1-1", "failed", 2, "s-b", undefined, "worker crashed"],
					["impl-T2-1", "ok", 1, "s-c", COMMIT_2, undefined],
				],
			],
			[2, [["impl-T1-1", "ok", 1, "s-d", COMMIT_1, undefined]]],
		]);
		expect(view.launches[0].steps[0].durationMs).toBe(3 * 60_000);

		renderApp("/runs/r-3", createFakeServer({ runs: [detail] }).fetch);
		expect(await screen.findByRole("heading", { name: "Retry a step" })).toBeTruthy();
		const launch1 = document.querySelector<HTMLElement>("[data-launch='1']")!;
		const launch2 = document.querySelector<HTMLElement>("[data-launch='2']")!;
		const failed = launch1.querySelector<HTMLElement>("[data-step='impl-T1-1']")!;
		for (const text of ["failed", "2 attempts", "worker crashed"]) expect(within(failed).getByText(text)).toBeTruthy();
		expect(within(failed).getByRole("link", { name: /Session/ }).getAttribute("href")).toBe("/s/s-b");
		const retried = launch2.querySelector<HTMLElement>("[data-step='impl-T1-1']")!;
		for (const text of ["ok", "1 attempt"]) expect(within(retried).getByText(text)).toBeTruthy();
		expect(within(retried).getByTitle(COMMIT_1)).toBeTruthy();
		expect(within(retried).getByRole("link", { name: /Session/ }).getAttribute("href")).toBe("/s/s-d");
		expect(within(launch2).queryByText("No steps")).toBeNull();
	});

	it("keeps the server's step session id when the journal names none", async () => {
		// Herder writes no sessionId on step.started, adopted commits, or older journals.
		const lines: Record<string, unknown>[] = [
			{ t: "run.started", runId: "r-4", title: "Live run", base: "abc", runtime: "herder 1", repo: "pi-extensions" },
			{ t: "script.launched", launch: 1, scriptSha256: "s1", args: {}, head: "abc" },
			{ t: "step.started", key: "impl-T1-1", id: "impl-T1", occurrence: 1, fingerprint: "f1", attempt: 1, role: "worker", write: true, base: "abc", task: "T1", launch: 1 },
			{ t: "step.completed", key: "impl-T1-1", fingerprint: "f1", status: "ok", commit: COMMIT_1 },
			{ t: "step.started", key: "impl-T2-1", id: "impl-T2", occurrence: 1, fingerprint: "f2", attempt: 1, role: "worker", write: true, base: "abc", task: "T2", launch: 1 },
		];
		const events = lines.map((line, index) => ({ seq: index, t: String(line.t), at: at(index), data: { v: 1, at: at(index), ...line } }));
		const detail: RunDetail = {
			run: { runId: "r-4", device: "mini", repo: "pi-extensions", title: "Live run", status: "running", startedAt: at(0), lastAt: at(4), stepCount: 2 },
			events,
			steps: [
				{ key: "impl-T1-1", id: "impl-T1", task: "T1", role: "worker", status: "ok", attempts: 1, sessionId: "s-old", commit: COMMIT_1, startedAt: at(2), endedAt: at(3) },
				{ key: "impl-T2-1", id: "impl-T2", task: "T2", role: "worker", status: "running", attempts: 1, sessionId: "s-live", startedAt: at(4) },
			],
		};

		const view = buildRunView(detail);
		expect(view.launches.map((group) => group.steps.map((step) => [step.key, step.status, step.sessionId]))).toEqual([
			[
				["impl-T1-1", "ok", "s-old"],
				["impl-T2-1", "running", "s-live"],
			],
		]);

		renderApp("/runs/r-4", createFakeServer({ runs: [detail] }).fetch);
		expect(await screen.findByRole("heading", { name: "Live run" })).toBeTruthy();
		const running = document.querySelector<HTMLElement>("[data-launch='1'] [data-step='impl-T2-1']")!;
		expect(within(running).getByRole("link", { name: /Session/ }).getAttribute("href")).toBe("/s/s-live");
	});

	it("redirects the old /herder routes", async () => {
		renderApp(`/herder/${RUN}`, createFakeServer({ runs: [runDetail()] }).fetch);
		expect(await screen.findByRole("heading", { name: "Add pika search" })).toBeTruthy();
	});
});
