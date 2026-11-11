import { describe, expect, it } from "vitest";
import { footerProcess, REQUEST_LIST, serveFooter } from "../../src/footer.ts";
import type { ProcessStatus } from "../../src/types.ts";
import { createBus, FakeManager, info } from "./fakes.ts";

describe("footerProcess", () => {
	it.each<[ProcessStatus, number | null | undefined, string, boolean]>([
		["starting", undefined, "running", false],
		["running", undefined, "running", false],
		["ready", undefined, "running", false],
		["stopping", undefined, "terminating", false],
		["exited", 0, "exited", true],
		["exited", 1, "exited", false],
		["exited", null, "exited", false],
		["stopped", null, "killed", false],
	])("maps %s (exit %s) to %s", (status, exitCode, mapped, success) => {
		expect(footerProcess(info({ status, exitCode }))).toMatchObject({ status: mapped, success, name: "dev" });
	});
});

describe("serveFooter", () => {
	it("replies with mapped processes until closed", () => {
		const bus = createBus();
		const manager = new FakeManager();
		manager.processes = [info({ status: "ready" }), info({ id: "p_2", status: "exited", exitCode: 0 }), info({ id: "p_3", status: "stopped" })];
		const close = serveFooter(bus, () => manager);
		let replied: unknown;
		bus.emit(REQUEST_LIST, { reply: (list: unknown) => (replied = list) });
		expect((replied as { status: string; success: boolean }[]).map(({ status, success }) => [status, success])).toEqual([
			["running", false],
			["exited", true],
			["killed", false],
		]);
		close();
		replied = undefined;
		bus.emit(REQUEST_LIST, { reply: (list: unknown) => (replied = list) });
		expect(replied).toBeUndefined();
	});

	it("replies with nothing before a manager exists and rejects requests without reply", () => {
		const bus = createBus();
		serveFooter(bus, () => undefined);
		let replied: unknown;
		bus.emit(REQUEST_LIST, { reply: (list: unknown) => (replied = list) });
		expect(replied).toEqual([]);
		expect(() => bus.emit(REQUEST_LIST, {})).toThrow(/reply/);
	});
});
