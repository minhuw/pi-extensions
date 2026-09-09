import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import extension from "../index.ts";
import provider from "../src/index.ts";
import tps from "../src/tps.ts";

vi.mock("../src/index.ts", () => ({ default: vi.fn() }));
vi.mock("../src/tps.ts", () => ({ default: vi.fn() }));

it("awaits provider setup before registering TPS, each exactly once", async () => {
	const pi = {} as ExtensionAPI;
	let finishProvider!: () => void;
	const pendingProvider = new Promise<void>((resolve) => { finishProvider = resolve; });
	vi.mocked(provider).mockReturnValueOnce(pendingProvider);
	const settled = vi.fn();
	const loading = extension(pi).then(settled);

	await Promise.resolve();
	expect(provider).toHaveBeenCalledExactlyOnceWith(pi);
	expect(tps).not.toHaveBeenCalled();
	expect(settled).not.toHaveBeenCalled();

	finishProvider();
	await loading;
	expect(provider).toHaveBeenCalledExactlyOnceWith(pi);
	expect(tps).toHaveBeenCalledExactlyOnceWith(pi);
	expect(settled).toHaveBeenCalledOnce();
});

it("registers only the wrapper, before statusline and native compaction", () => {
	const { pi: { extensions } } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
		pi: { extensions: string[] };
	};
	const entry = "./extensions/cliproxyapi-provider/index.ts";
	expect(extensions.filter((path) => path.startsWith("./extensions/cliproxyapi-provider/"))).toEqual([entry]);
	for (const sibling of ["statusline-footer", "cliproxyapi-native-compaction"]) {
		expect(extensions.indexOf(entry)).toBeLessThan(extensions.indexOf(`./extensions/${sibling}/index.ts`));
	}
});
