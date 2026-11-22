import { beforeEach, describe, expect, it } from "vitest";
import { sharedState } from "../../src/state.ts";
import { ACTIONS, CLEAR, processLabel, registerPsCommand } from "../../src/ui.ts";
import { createCtx, createPi, FakeManager, info, resetShared } from "./fakes.ts";

beforeEach(resetShared);

function setup(ctxOverrides: Record<string, unknown> = {}) {
	const pi = createPi();
	const manager = new FakeManager();
	registerPsCommand(pi.api, () => manager);
	const ctx = createCtx("session-a", ctxOverrides);
	return { manager, ctx, run: () => pi.commands.get("ps")!.handler("", ctx) };
}

describe("/ps", () => {
	it("prints the table without a UI", async () => {
		const { manager, ctx, run } = setup({ hasUI: false });
		manager.processes = [info()];
		await run();
		expect(ctx.ui.notify.mock.calls[0]![0]).toMatch(/^NAME\s+ID/);
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("offers Clear finished only when something finished", async () => {
		const { manager, ctx, run } = setup();
		manager.processes = [info()];
		ctx.ui.select.mockResolvedValueOnce(undefined);
		await run();
		expect(ctx.ui.select.mock.calls[0]![1]).toEqual([processLabel(manager.processes[0]!)]);
		manager.processes = [info(), info({ id: "p_2", status: "exited", exitCode: 0 })];
		ctx.ui.select.mockResolvedValueOnce(CLEAR);
		await run();
		expect(ctx.ui.select.mock.calls[1]![1].at(-1)).toBe(CLEAR);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("Cleared 0 finished processes.", "info");
	});

	it("stops after confirmation, marked as the user's request", async () => {
		const { manager, ctx, run } = setup();
		manager.processes = [info()];
		const seen: unknown[] = [];
		manager.subscribe(() => seen.push(sharedState().requested.get("p_1")));
		ctx.ui.select.mockResolvedValueOnce(processLabel(manager.processes[0]!)).mockResolvedValueOnce(ACTIONS.stop);
		ctx.ui.confirm.mockResolvedValueOnce(false);
		await run();
		expect(seen).toEqual([]);
		ctx.ui.select.mockResolvedValueOnce(processLabel(manager.processes[0]!)).mockResolvedValueOnce(ACTIONS.stop);
		ctx.ui.confirm.mockResolvedValueOnce(true);
		await run();
		expect(seen).toEqual([{ by: "user", session: "session-a" }]);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("dev: terminated.", "info");
	});

	it("labels processes", () => {
		expect(processLabel(info({ status: "ready", urls: ["http://127.0.0.1:3000"] }))).toBe("dev  p_1  ready  pid 4242  http://127.0.0.1:3000");
		expect(processLabel(info({ status: "exited", exitCode: 1, pid: undefined }))).toBe("dev  p_1  exited (code 1)");
	});

	it("strips terminal sequences from shown logs", async () => {
		const { manager, ctx, run } = setup({ mode: "rpc" });
		manager.processes = [info()];
		manager.logs = async () => ({ lines: ["\x1b[32mok\x1b[0m\x07 done\r", "\x1b]0;title\x07next\tline"], nextCursor: 0, truncated: false, more: false });
		ctx.ui.select.mockResolvedValueOnce(processLabel(manager.processes[0]!)).mockResolvedValueOnce(ACTIONS.logs);
		await run();
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("dev · /logs/p_1.log\nok done\nnext\tline", "info");
	});
});
