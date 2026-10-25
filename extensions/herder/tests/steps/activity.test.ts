import { describe, expect, it } from "vitest";
import type { StepActivity } from "../../src/steps/executor.ts";
import { withRun } from "./harness.ts";

describe("step activity", () => {
	it("carries role, prompt, attempt, start time, and the live session, and settles with the status", () => withRun(async (h) => {
		const activities: StepActivity[] = [];
		const live = { id: "session" };
		h.runner.add({ match: "add the feature", files: { "feature.txt": "feature\n" }, text: "added", edit: (_cwd, request) => request.onLiveSession?.(live) });
		const result = await h.executor({ onActivity: (activity) => activities.push(activity) }).run("add the feature", { task: "T1", label: "impl" });
		expect(result.status).toBe("ok");
		const running = activities.filter((activity) => activity.state === "running");
		expect(running[0]).toMatchObject({ key: result.key, label: "impl", task: "T1", role: "worker", prompt: "add the feature", attempt: 1, startedAt: expect.any(Number) });
		expect(running[0]!.session).toBeUndefined();
		expect(running.at(-1)).toMatchObject({ attempt: 1, startedAt: running[0]!.startedAt });
		expect(running.at(-1)!.session).toBe(live);
		expect(activities.at(-1)).toEqual({ key: result.key, label: "impl", task: "T1", state: "settled", role: "worker", status: "ok" });
	}));

	it("a retry starts without the failed attempt's session", () => withRun(async (h) => {
		const activities: StepActivity[] = [];
		h.runner.add({ match: "flaky", fail: "transient", times: 1, edit: (_cwd, request) => request.onLiveSession?.({}) });
		h.runner.add({ match: "flaky", text: "done" });
		const result = await h.executor({ onActivity: (activity) => activities.push(activity) }).run("flaky", { write: false });
		expect(result.status).toBe("ok");
		const second = activities.filter((activity) => activity.state === "running" && activity.attempt === 2);
		expect(second.length).toBeGreaterThan(0);
		expect(second.every((activity) => activity.session === undefined)).toBe(true);
		const first = activities.find((activity) => activity.attempt === 1)!;
		expect(second[0]!.startedAt).toBeGreaterThanOrEqual(first.startedAt!);
	}));

	it("settles a failed step with its status", () => withRun(async (h) => {
		const activities: StepActivity[] = [];
		h.runner.add({ match: "broken", fail: "fatal" });
		const result = await h.executor({ onActivity: (activity) => activities.push(activity) }).run("broken", { write: false });
		expect(result.status).toBe("failed");
		expect(activities.at(-1)).toMatchObject({ state: "settled", status: "failed" });
	}));
});
