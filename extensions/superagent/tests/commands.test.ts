import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerCommands } from "../src/commands.ts";
import type { Dispatcher } from "../src/dispatcher.ts";
import type { Router } from "../src/router.ts";
import type { MergeOutcome, Ticket, TicketState } from "../src/types.ts";

const ticket = (id: number, state: TicketState = "ready", workspace?: "shared"): Ticket => ({
	version: 1, id, slug: `ticket-${id}`, title: `Ticket ${id}`, request: "work", source: "work",
	createdAt: 1, updatedAt: 1, createdBy: "session", owner: "session", base: "base", branch: `pi/${id}`,
	worktree: `/worktrees/${id}`, state, ...(workspace ? { workspace } : {}),
});

function setup(open: Ticket[] = []) {
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const pi = { registerCommand: (name, options) => { commands.set(name, options); } } as ExtensionAPI;
	const list = vi.fn(() => [...open]);
	const merge = vi.fn<Dispatcher["merge"]>(async () => ({ kind: "merged", into: "main", commits: 1 }));
	const mergeWhenReady = vi.fn<Dispatcher["mergeWhenReady"]>(async (id) => {
		const current = open.find((item) => item.id === id)!;
		return { ticket: { ...current, mergeWhenReady: true }, ...(current.state === "ready" ? { outcome: await merge(id) } : {}) };
	});
	const changed = vi.fn();
	const notify = vi.fn();
	registerCommands(pi, {
		dispatcher: () => ({ list, merge, mergeWhenReady }) as unknown as Dispatcher,
		router: {} as Router, changed,
	});
	const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
	return { list, merge, mergeWhenReady, changed, notify, run: (args = "") => commands.get("merge")!.handler(args, ctx) };
}

describe("/merge", () => {
	it("reports an empty open-ticket snapshot", async () => {
		const t = setup();
		await t.run("  ");
		expect(t.list).toHaveBeenCalledExactlyOnceWith();
		expect(t.notify).toHaveBeenCalledExactlyOnceWith("No open tickets.", "info");
		expect(t.mergeWhenReady).not.toHaveBeenCalled();
		expect(t.changed).not.toHaveBeenCalled();
	});

	it("requests one sorted snapshot sequentially and reports immediate and scheduled results", async () => {
		const open = [ticket(3), ticket(2, "working"), ticket(1)];
		const t = setup(open);
		let finish!: () => void;
		const first = new Promise<void>((resolve) => { finish = resolve; });
		t.mergeWhenReady.mockImplementationOnce(async (id) => {
			await first;
			open.push(ticket(4));
			return { ticket: ticket(id), outcome: { kind: "merged", into: "main", commits: 2 } };
		});
		const run = t.run();
		expect(t.mergeWhenReady.mock.calls).toEqual([[1]]);
		finish();
		await run;
		expect(t.list).toHaveBeenCalledTimes(1);
		expect(t.mergeWhenReady.mock.calls).toEqual([[1], [2], [3]]);
		expect(t.notify.mock.calls).toEqual([
			["Merged #1 into main (2 commits).", "info"],
			["#2 [working] will merge when it reports ready and its run ends.", "info"],
			["Merged #3 into main (1 commit).", "info"],
		]);
		expect(t.changed).toHaveBeenCalledTimes(1);
	});

	it("marks shared tickets done now or when ready, with shared-workspace wording", async () => {
		const t = setup([ticket(1, "ready", "shared"), ticket(2, "working", "shared")]);
		t.merge.mockResolvedValue({ kind: "done" });
		await t.run();
		expect(t.notify.mock.calls).toEqual([
			["#1 is done; its changes stay uncommitted in your working tree.", "info"],
			["#2 [working] will be marked done when it reports ready and its run ends.", "info"],
		]);
	});

	it.each(["blocked", "failed", "interrupted", "question", "waiting"] as const)("surfaces scheduled %s tickets as still needing attention", async (state) => {
		const t = setup([ticket(1, state)]);
		await t.run();
		expect(t.notify).toHaveBeenCalledWith(`#1 [${state}] will merge when it reports ready and its run ends. It still needs attention.`, "warning");
		expect(t.merge).not.toHaveBeenCalled();
	});

	it("continues after a foreign owner error, a refusal, and a conflict handoff", async () => {
		const t = setup([ticket(1), ticket(2), ticket(3), ticket(4)]);
		t.mergeWhenReady.mockRejectedValueOnce(new Error("Ticket #1 is run by another Pi session (other, pid 200); send it messages from there."));
		t.merge.mockResolvedValueOnce({ kind: "refused", reason: "dirty checkout" });
		t.merge.mockResolvedValueOnce({ kind: "handed-to-worker", reason: "conflicts in a.ts" });
		await t.run();
		expect(t.mergeWhenReady.mock.calls).toEqual([[1], [2], [3], [4]]);
		expect(t.notify.mock.calls).toEqual([
			["#1 was not merged: Ticket #1 is run by another Pi session (other, pid 200); send it messages from there.", "error"],
			["#2 was not merged: dirty checkout", "error"],
			["#3 needs a rebase: conflicts in a.ts The merge runs again when it reports ready.", "warning"],
			["Merged #4 into main (1 commit).", "info"],
		]);
		expect(t.changed).toHaveBeenCalledTimes(1);
	});

	it.each(["all", "1 2", "#", "1 extra", "-1", "1.5"])("rejects malformed explicit arguments: %s", async (args) => {
		const t = setup();
		await t.run(args);
		expect(t.notify).toHaveBeenCalledExactlyOnceWith("Usage: /merge [N]", "error");
		expect(t.list).not.toHaveBeenCalled();
		expect(t.merge).not.toHaveBeenCalled();
		expect(t.mergeWhenReady).not.toHaveBeenCalled();
	});

	it.each<MergeOutcome>([
		{ kind: "merged", into: "main", commits: 1 }, { kind: "done" },
		{ kind: "refused", reason: "running" }, { kind: "handed-to-worker", reason: "conflicts" },
	])("keeps explicit /merge N on the immediate pipeline: $kind", async (outcome) => {
		const t = setup();
		t.merge.mockResolvedValue(outcome);
		await t.run(" #7 ");
		expect(t.merge).toHaveBeenCalledExactlyOnceWith(7);
		expect(t.mergeWhenReady).not.toHaveBeenCalled();
		expect(t.list).not.toHaveBeenCalled();
		expect(t.changed).toHaveBeenCalledTimes(1);
		expect(t.notify).toHaveBeenCalledTimes(1);
	});
});
