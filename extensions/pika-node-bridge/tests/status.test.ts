import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Activities } from "../activity.ts";
import { parse } from "../navigation.ts";
import { clean, describeSession, PaneStatus } from "../status.ts";

const snapshot = (source: string, ...rows: Array<[string, string] | Record<string, unknown>>) => ({
	source,
	activities: rows.map(row => Array.isArray(row) ? { id: row[0], label: row[1] } : row),
});

function context(manager: Record<string, () => unknown>, extra: Record<string, unknown> = {}): ExtensionContext {
	return { cwd: "/fallback", sessionManager: manager, ...extra } as unknown as ExtensionContext;
}

let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

describe("root state", () => {
	it("is busy from agent_start to agent_settled and waiting while any prompt is open", () => {
		const pane = new PaneStatus();
		expect(pane.state).toBe("idle");
		pane.agentStart();
		expect(pane.state).toBe("busy");
		pane.promptStart();
		pane.promptStart();
		expect(pane.state).toBe("waiting");
		pane.promptEnd();
		expect(pane.state).toBe("waiting");
		pane.promptEnd();
		expect(pane.state).toBe("busy");
		pane.promptEnd();
		expect(pane.promptDepth).toBe(0);
		pane.agentSettled();
		expect(pane.state).toBe("idle");
	});

	it("reports activities and their total, but leaves merging them into the state to the daemon", () => {
		const pane = new PaneStatus();
		pane.activities.update(snapshot("subagents", ["a1", "recon"]));
		const status = pane.snapshot(undefined, 5);
		expect(status).toEqual({ state: "idle", activities: [{ source: "subagents", id: "a1", label: "recon" }], activityCount: 1, updatedAt: 5 });
		expect(pane.final(undefined, 6)).toEqual({ state: "idle", activities: [], activityCount: 0, updatedAt: 6 });
	});
});

describe("activities", () => {
	it("replaces each source's whole list and keeps sources and ids independent", () => {
		const activities = new Activities();
		expect(activities.update(snapshot("herder", ["same", "Build"], ["second", "Review"]))).toBe(true);
		expect(activities.update(snapshot("subagents", ["same", "Inspect"]))).toBe(true);
		expect(activities.size).toBe(3);
		expect(activities.update(snapshot("herder", ["second", "Review"]))).toBe(true);
		expect(activities.entries()).toEqual([
			{ source: "herder", id: "second", label: "Review" },
			{ source: "subagents", id: "same", label: "Inspect" },
		]);
		// The same snapshot again, reordered or not, is no change.
		expect(activities.update(snapshot("herder", ["second", "Review"]))).toBe(false);
		expect(activities.update(snapshot("subagents"))).toBe(true);
		expect(activities.entries()).toEqual([{ source: "herder", id: "second", label: "Review" }]);
	});

	it("rejects an invalid snapshot whole and keeps the previous one", () => {
		const activities = new Activities();
		activities.update(snapshot("herder", ["a", "Build"]));
		for (const bad of [
			snapshot("herder", ["a", "x"], ["a", "y"]),
			snapshot("bad:source", ["a", "x"]),
			snapshot("herder", { id: "b", label: "x", kind: "nope" }),
			snapshot("herder", { id: "b", label: "x", progress: { completed: 2, total: 1 } }),
			snapshot("herder", ["c", "line\nbreak"]),
			{ source: "herder", activities: "nope" },
		]) expect(activities.update(bad)).toBe(false);
		expect(activities.entries()).toEqual([{ source: "herder", id: "a", label: "Build" }]);
	});

	it("sends at most 128 rows with the full count", () => {
		const pane = new PaneStatus();
		for (let source = 0; source < 3; source++) {
			pane.activities.update(snapshot(`s${source}`, ...Array.from({ length: 100 }, (_, i) => [`a${i}`, `task ${i}`] as [string, string])));
		}
		const status = pane.snapshot(undefined);
		expect(status.activities).toHaveLength(128);
		expect(status.activityCount).toBe(300);
	});
});

describe("session", () => {
	it("reads id, name, cwd, and an existing file from the session manager", () => {
		directory = mkdtempSync(join(tmpdir(), "pnb-session-"));
		const file = join(directory, "session.jsonl");
		const manager = { getSessionId: () => "s-1", getCwd: () => "/work/project", getSessionName: () => "  Fix\tthe\x1b[31m bug ", getSessionFile: () => file };
		expect(describeSession(context(manager))).toEqual({ id: "s-1", cwd: "/work/project", name: "Fix the [31m bug" });
		writeFileSync(file, "");
		expect(describeSession(context(manager))).toEqual({ id: "s-1", cwd: "/work/project", name: "Fix the [31m bug", file });
	});

	it("leaves the session out when its id or cwd is unusable, and tolerates throwing getters", () => {
		expect(describeSession(context({ getSessionId: () => "", getCwd: () => "/w" }))).toBeUndefined();
		expect(describeSession(context({ getSessionId: () => "s", getCwd: () => "relative" }))).toBeUndefined();
		const throwing = context({ getSessionId: () => "s", getCwd: () => { throw new Error("stale"); }, getSessionName: () => { throw new Error("stale"); }, getSessionFile: () => "relative.jsonl" });
		expect(describeSession(throwing)).toEqual({ id: "s", cwd: "/fallback" });
	});

	it("cuts labels to the daemon's limits", () => {
		expect(clean("x".repeat(300), 240)).toHaveLength(240);
		expect(clean(" \n ", 240)).toBeUndefined();
		expect(clean(42, 240)).toBeUndefined();
	});

	it("names the model as provider/id", () => {
		const pane = new PaneStatus();
		const status = pane.snapshot(context({ getSessionId: () => "s", getCwd: () => "/w" }, { model: { provider: "magpie", id: "claude-opus-5-5" } }), 1);
		expect(status).toMatchObject({ model: "magpie/claude-opus-5-5", session: { id: "s", cwd: "/w" } });
	});
});

describe("arguments", () => {
	it("parses /pika-open and /pika-diff like the Orca commands", () => {
		expect(parse(`"Reports/Review Report.md" --line 42 --column 7`, "open")).toEqual({ path: "Reports/Review Report.md", staged: false, line: 42, column: 7 });
		expect(parse("src/a.ts --staged", "diff")).toEqual({ path: "src/a.ts", staged: true });
		expect(parse(`-- "-leading-dash.md"`, "open")).toMatchObject({ path: "-leading-dash.md" });
		expect(() => parse("a.ts --staged", "open")).toThrow(/Unknown or unsupported option/);
		expect(() => parse("a.ts --line 2", "diff")).toThrow(/Unknown or unsupported option/);
		expect(() => parse("a.ts --column 3", "open")).toThrow(/--column requires --line/);
		expect(() => parse("a.ts --line 0", "open")).toThrow(/positive safe integers/);
		expect(() => parse("a.ts --line 1 --line 2", "open")).toThrow(/Duplicate option/);
		expect(() => parse("a.ts b.ts", "open")).toThrow(/Usage: \/pika-open/);
		expect(() => parse(`"unclosed`, "diff")).toThrow(/Unclosed quote/);
		expect(() => parse("", "diff")).toThrow(/Usage: \/pika-diff/);
	});
});
