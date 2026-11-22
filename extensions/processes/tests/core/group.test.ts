import { afterEach, describe, expect, it, vi } from "vitest";
import { groupAlive, pidAlive } from "../../src/core/group.ts";
import { isLive } from "../../src/format.ts";
import { isLiveStatus, type ProcessInfo, type ProcessStatus } from "../../src/types.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("pidAlive and groupAlive", () => {
	it("probes pid and -pgid with signal 0", () => {
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		expect(pidAlive(1234)).toBe(true);
		expect(groupAlive(5678)).toBe(true);
		expect(killSpy).toHaveBeenNthCalledWith(1, 1234, 0);
		expect(killSpy).toHaveBeenNthCalledWith(2, -5678, 0);
	});

	it("preserves ESRCH, EPERM, and rethrow semantics for both helpers", () => {
		const killSpy = vi.spyOn(process, "kill");

		killSpy.mockImplementation(() => {
			throw errno("ESRCH");
		});
		expect(pidAlive(42)).toBe(false);
		expect(groupAlive(42)).toBe(false);

		killSpy.mockImplementation(() => {
			throw errno("EPERM");
		});
		expect(pidAlive(42)).toBe(true);
		expect(groupAlive(42)).toBe(true);

		const unexpected = errno("EINVAL");
		killSpy.mockImplementation(() => {
			throw unexpected;
		});
		expect(() => pidAlive(42)).toThrow(unexpected);
		expect(() => groupAlive(42)).toThrow(unexpected);
	});
});

describe("isLiveStatus", () => {
	it.each<[ProcessStatus, boolean]>([
		["starting", true],
		["running", true],
		["ready", true],
		["stopping", true],
		["exited", false],
		["stopped", false],
	])("classifies %s as live=%s consistently with format.isLive", (status, expected) => {
		expect(isLiveStatus(status)).toBe(expected);
		const info: ProcessInfo = {
			id: "p_0001",
			name: "dev",
			command: "true",
			cwd: "/tmp",
			owner: "test",
			pid: 1,
			status,
			startedAt: 0,
			urls: [],
			logPath: "/tmp/p_0001.log",
			logBytes: 0,
			restarts: 0,
			attached: false,
		};
		expect(isLive(info)).toBe(expected);
	});
});
