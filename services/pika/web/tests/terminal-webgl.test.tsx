import { render, waitFor } from "@testing-library/react";
import { WebglAddon } from "@xterm/addon-webgl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeChannel } from "../src/nodes/channel";
import type { TerminalInfo } from "../src/nodes/contract";
import type { Renderer } from "../src/nodes/renderer";
import { resetWebgl2AvailableCacheForTest, TerminalView, webgl2Available } from "../src/nodes/TerminalView";

const info = (terminalId: string): TerminalInfo => ({
	terminalId,
	title: "",
	cwd: "/p",
	cols: 80,
	rows: 24,
	pid: 1,
	createdAt: 1,
	argv: ["bash"],
});

function fakeChannel(): NodeChannel {
	return {
		request: vi.fn((type: string, params: { terminalId: string }) =>
			type === "term.attach"
				? Promise.resolve({ terminal: info(params.terminalId), snapshot: { data: "", cols: 80, rows: 24, outputSequence: 0 } })
				: Promise.resolve({}),
		),
		notify: vi.fn(() => Promise.resolve()),
		onEvent: () => () => {},
	} as unknown as NodeChannel;
}

beforeEach(() => {
	resetWebgl2AvailableCacheForTest();
});

afterEach(() => {
	resetWebgl2AvailableCacheForTest();
	vi.restoreAllMocks();
});

describe("webgl2Available", () => {
	it("immediately releases the probe context via WEBGL_lose_context and resets the canvas", () => {
		const loseContext = vi.fn();
		const getExtension = vi.fn(() => ({ loseContext }));
		let probedCanvas: HTMLCanvasElement | undefined;
		const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, contextId: string) {
			if (contextId !== "webgl2") return null;
			probedCanvas = this;
			return { getExtension } as unknown as WebGL2RenderingContext;
		} as HTMLCanvasElement["getContext"]);

		expect(webgl2Available()).toBe(true);
		expect(getContext).toHaveBeenCalledTimes(1);
		expect(getContext).toHaveBeenCalledWith("webgl2");
		expect(getExtension).toHaveBeenCalledTimes(1);
		expect(getExtension).toHaveBeenCalledWith("WEBGL_lose_context");
		expect(loseContext).toHaveBeenCalledTimes(1);
		expect(probedCanvas?.width).toBe(0);
		expect(probedCanvas?.height).toBe(0);
	});

	it("caches repeated probe calls so getContext('webgl2') is invoked only once", () => {
		const loseContext = vi.fn();
		const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((contextId: string) => {
			if (contextId !== "webgl2") return null;
			return { getExtension: () => ({ loseContext }) } as unknown as WebGL2RenderingContext;
		});

		expect(webgl2Available()).toBe(true);
		expect(webgl2Available()).toBe(true);
		expect(webgl2Available()).toBe(true);
		expect(getContext).toHaveBeenCalledTimes(1);
		expect(loseContext).toHaveBeenCalledTimes(1);
	});

	it("returns and caches false safely when getContext('webgl2') returns null", () => {
		const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

		expect(webgl2Available()).toBe(false);
		expect(webgl2Available()).toBe(false);
		expect(getContext).toHaveBeenCalledTimes(1);
	});

	it("returns and caches false safely when getContext('webgl2') throws", () => {
		const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
			throw new Error("WebGL disabled");
		});

		expect(webgl2Available()).toBe(false);
		expect(webgl2Available()).toBe(false);
		expect(getContext).toHaveBeenCalledTimes(1);
	});

	it("handles missing or throwing getExtension without failing the probe", () => {
		const getContext = vi
			.spyOn(HTMLCanvasElement.prototype, "getContext")
			.mockReturnValueOnce({} as unknown as WebGL2RenderingContext)
			.mockReturnValueOnce({
				getExtension: () => {
					throw new Error("extension blocked");
				},
			} as unknown as WebGL2RenderingContext);

		expect(webgl2Available()).toBe(true);
		expect(getContext).toHaveBeenCalledTimes(1);

		resetWebgl2AvailableCacheForTest();
		expect(webgl2Available()).toBe(true);
		expect(getContext).toHaveBeenCalledTimes(2);
	});
});

describe("TerminalView WebGL2 probing", () => {
	it("probes WebGL2 only once across multiple TerminalView mounts and disposes addons on unmount", async () => {
		const loseContext = vi.fn();
		const getExtension = vi.fn(() => ({ loseContext }));
		const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((contextId: string) => {
			if (contextId !== "webgl2") return null;
			return { getExtension } as unknown as WebGL2RenderingContext;
		});
		const activate = vi.spyOn(WebglAddon.prototype, "activate").mockImplementation(() => {});
		const dispose = vi.spyOn(WebglAddon.prototype, "dispose").mockImplementation(() => {});

		const renderersA: Renderer[] = [];
		const renderersB: Renderer[] = [];
		const first = render(
			<TerminalView
				channel={fakeChannel()}
				terminal={info("t1")}
				theme="dark"
				home="/home/me"
				onKill={() => {}}
				onOpenFile={() => {}}
				onRenderer={(r) => renderersA.push(r)}
			/>,
		);
		const second = render(
			<TerminalView
				channel={fakeChannel()}
				terminal={info("t2")}
				theme="dark"
				home="/home/me"
				onKill={() => {}}
				onOpenFile={() => {}}
				onRenderer={(r) => renderersB.push(r)}
			/>,
		);

		await waitFor(() => {
			expect(renderersA).toContain("webgl");
			expect(renderersB).toContain("webgl");
		});

		const webgl2Calls = getContext.mock.calls.filter(([kind]) => kind === "webgl2");
		expect(webgl2Calls).toHaveLength(1);
		expect(getExtension).toHaveBeenCalledWith("WEBGL_lose_context");
		expect(loseContext).toHaveBeenCalledTimes(1);
		expect(activate).toHaveBeenCalledTimes(2);

		first.unmount();
		second.unmount();
		expect(dispose).toHaveBeenCalledTimes(2);
	});
});
