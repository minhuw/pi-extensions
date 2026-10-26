import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isExcluded, loadConfig } from "../config.ts";
import { statusText } from "../index.ts";

it("reads pika.json, lets PIKA_URL and PIKA_TOKEN override it, and always honors PIKA_DISABLED=1", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pika-config-"));
	try {
		expect(loadConfig(dir, {})).toMatchObject({ enabled: false, reason: expect.stringMatching(/no server url and token/) });
		await writeFile(join(dir, "pika.json"), JSON.stringify({ url: "http://files/pika/", token: "file-token", exclude: ["/secret", 3] }));
		expect(loadConfig(dir, {})).toEqual({ enabled: true, file: join(dir, "pika.json"), config: { url: "http://files/pika", token: "file-token", exclude: ["/secret"] } });
		expect(loadConfig(dir, { PIKA_URL: "https://env/pika", PIKA_TOKEN: "env-token" })).toMatchObject({ enabled: true, config: { url: "https://env/pika", token: "env-token" } });
		expect(loadConfig(dir, { PIKA_DISABLED: "1" })).toMatchObject({ enabled: false, reason: "PIKA_DISABLED=1 is set" });
		await writeFile(join(dir, "pika.json"), JSON.stringify({ url: "http://files/pika", token: "t", enabled: false }));
		expect(loadConfig(dir, { PIKA_URL: "http://env", PIKA_TOKEN: "t" })).toMatchObject({ enabled: false, reason: expect.stringMatching(/"enabled" is false/) });
		await writeFile(join(dir, "pika.json"), JSON.stringify({ url: "ftp://files", token: "t" }));
		expect(loadConfig(dir, {})).toMatchObject({ enabled: false, reason: expect.stringMatching(/invalid server url/) });
		await writeFile(join(dir, "pika.json"), "{");
		expect(loadConfig(dir, {})).toMatchObject({ enabled: false, reason: expect.stringMatching(/cannot read/) });
	} finally { await rm(dir, { recursive: true, force: true }); }
});

it("excludes cwd prefixes on directory boundaries and globs that match the cwd or an ancestor", () => {
	expect(isExcluded("/work/secret", ["/work/secret"])).toBe(true);
	expect(isExcluded("/work/secret/app", ["/work/secret/"])).toBe(true);
	expect(isExcluded("/work/secrets", ["/work/secret"])).toBe(false);
	expect(isExcluded(join(homedir(), "private", "x"), ["~/private"])).toBe(true);
	expect(isExcluded("/work/client-a/app", ["/work/client-*"])).toBe(true);
	expect(isExcluded("/work/client-a/app", ["/work/*/app"])).toBe(true);
	expect(isExcluded("/work/other/app", ["/work/client-*"])).toBe(false);
	expect(isExcluded("/a/b/c/d", ["/a/**/d"])).toBe(true);
	expect(isExcluded("/work/app", [])).toBe(false);
});

it("resolves relative globs and plain paths alike against pi's start directory, and matches **/ at any depth", () => {
	const start = process.cwd();
	expect(isExcluded(join(start, "scratch", "a"), ["scratch"])).toBe(true);
	expect(isExcluded(join(start, "scratch", "a", "b"), ["scratch/*"])).toBe(true);
	expect(isExcluded(join(start, "scratch"), ["scratch/*"])).toBe(false);
	expect(isExcluded(join(start, "other", "scratch", "a"), ["scratch/*"])).toBe(false);
	expect(isExcluded(join(start, "tmp-1"), ["./tmp-*"])).toBe(true);
	expect(isExcluded(join(homedir(), "x", "a", "b"), ["~/x/*"])).toBe(true);
	expect(isExcluded(join(homedir(), "y", "a"), ["~/x/*"])).toBe(false);
	expect(isExcluded("/srv/deep/down/secret", ["**/secret"])).toBe(true);
	expect(isExcluded("/srv/deep/secret/app", ["**/secret"])).toBe(true);
	expect(isExcluded("/srv/deep/secretive", ["**/secret"])).toBe(false);
	expect(isExcluded("/srv/client-a/app", ["/srv/client-*/app"])).toBe(true);
	expect(isExcluded("/srv/client-a/web", ["/srv/client-*/app"])).toBe(false);
});

it("explains in /pika why pika is disabled", () => {
	expect(statusText({ enabled: false, reason: "PIKA_DISABLED=1 is set", file: "/x/pika.json" }, false, undefined, undefined)).toBe("pika is disabled: PIKA_DISABLED=1 is set.");
	expect(statusText({ enabled: true, file: "/x/pika.json", config: { url: "http://h/pika", token: "t", exclude: [] } }, true, "abc", "/w is excluded"))
		.toContain("This session: not captured, /w is excluded");
});
