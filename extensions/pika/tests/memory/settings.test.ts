import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadMemorySettings } from "../../config.ts";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pika-memory-settings-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const write = (value: unknown) => writeFile(join(dir, "pika.json"), typeof value === "string" ? value : JSON.stringify(value));

it("defaults without a file, without a memory key, and for an unreadable file", async () => {
	expect(loadMemorySettings(dir)).toEqual({ autoDream: true, dreamIdleMinutes: 20 });
	await write({ url: "https://pika.example" });
	expect(loadMemorySettings(dir)).toEqual({ autoDream: true, dreamIdleMinutes: 20 });
	await write("{ not json");
	expect(loadMemorySettings(dir)).toEqual({ autoDream: true, dreamIdleMinutes: 20 });
});

it("reads autoDream, dreamIdleMinutes, and dreamModel", async () => {
	await write({ memory: { autoDream: false, dreamIdleMinutes: 5, dreamModel: " anthropic/claude-haiku-5-5 " } });
	expect(loadMemorySettings(dir)).toEqual({ autoDream: false, dreamIdleMinutes: 5, dreamModel: "anthropic/claude-haiku-5-5" });
});

it.each([
	[{ autoDream: "no" }],
	[{ dreamIdleMinutes: 0 }],
	[{ dreamIdleMinutes: "20" }],
	[{ dreamModel: "no-slash" }],
	[{ dreamModel: "/id" }],
	[{ dreamModel: "provider/" }],
	[{ dreamModel: 3 }],
])("falls back to the default for an invalid value: %j", async (memory) => {
	await write({ memory });
	expect(loadMemorySettings(dir)).toEqual({ autoDream: true, dreamIdleMinutes: 20 });
});
