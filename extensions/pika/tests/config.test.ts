import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
		expect(loadConfig(dir, {})).toEqual({
			enabled: false,
			reason: `cannot parse ${join(dir, "pika.json")} as JSON; fix or remove it`,
			file: join(dir, "pika.json"),
			unreadable: true,
		});
	} finally { await rm(dir, { recursive: true, force: true }); }
});

it("rejects a server url with credentials, a query, or a fragment, without repeating it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pika-config-"));
	const file = join(dir, "pika.json");
	try {
		await writeFile(file, JSON.stringify({ url: "https://alice:hunter2@pika.example.com", token: "t" }));
		const fromFile = loadConfig(dir, {});
		expect(fromFile).toEqual({ enabled: false, reason: `invalid server url in ${file}: the server URL must not contain credentials`, file });
		const fromEnv = loadConfig(dir, { PIKA_URL: "http://bob:s3cret@127.0.0.1:17171" });
		expect(fromEnv).toEqual({ enabled: false, reason: "invalid server url in PIKA_URL: the server URL must not contain credentials", file });
		for (const result of [fromFile, fromEnv]) expect(JSON.stringify(result)).not.toMatch(/hunter2|s3cret|alice|bob/);
		expect(loadConfig(dir, { PIKA_URL: "https://pika.example.com/?x=1" })).toMatchObject({ enabled: false, reason: "invalid server url in PIKA_URL: the server URL must not have a query or fragment" });
		expect(loadConfig(dir, { PIKA_URL: "https://Pika.Example.com:443/pika//" })).toMatchObject({ enabled: true, config: { url: "https://Pika.Example.com:443/pika" } });
		await writeFile(file, `{ "token": "pika_secret" `);
		expect(loadConfig(dir, {})).toEqual({ enabled: false, reason: `cannot parse ${file} as JSON; fix or remove it`, file, unreadable: true });
	} finally { await rm(dir, { recursive: true, force: true }); }
});

it("omits unvalidated urls on disabled results and keeps only validated normalized urls", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pika-config-"));
	const file = join(dir, "pika.json");
	const invalidUrls = [
		"https://testuser:dummy-pass-1@pika.example.com/pika",
		"https://pika.example.com/pika?token=dummy-query-1",
		"https://pika.example.com/pika#dummy-frag-1",
		"ftp://pika.example.com/pika",
		"dummy-mistyped-secret-1",
	];
	try {
		for (const badUrl of invalidUrls) {
			// PIKA_DISABLED=1 with invalid url in file
			await writeFile(file, JSON.stringify({ url: badUrl, token: "t" }));
			const disabledFile = loadConfig(dir, { PIKA_DISABLED: "1" });
			expect(disabledFile).toEqual({ enabled: false, reason: "PIKA_DISABLED=1 is set", file });
			expect("url" in disabledFile).toBe(false);

			// PIKA_DISABLED=1 with invalid url in env
			const disabledEnv = loadConfig(dir, { PIKA_DISABLED: "1", PIKA_URL: badUrl });
			expect(disabledEnv).toEqual({ enabled: false, reason: "PIKA_DISABLED=1 is set", file });
			expect("url" in disabledEnv).toBe(false);

			// enabled: false with invalid url in file
			await writeFile(file, JSON.stringify({ url: badUrl, token: "t", enabled: false }));
			const enabledFalseFile = loadConfig(dir, {});
			expect(enabledFalseFile).toEqual({ enabled: false, reason: `"enabled" is false in ${file}`, file });
			expect("url" in enabledFalseFile).toBe(false);

			// enabled: false with invalid url in env
			const enabledFalseEnv = loadConfig(dir, { PIKA_URL: badUrl });
			expect(enabledFalseEnv).toEqual({ enabled: false, reason: `"enabled" is false in ${file}`, file });
			expect("url" in enabledFalseEnv).toBe(false);

			// unconfigured (url without token) in file
			await writeFile(file, JSON.stringify({ url: badUrl }));
			const unconfiguredFile = loadConfig(dir, {});
			expect(unconfiguredFile).toEqual({
				enabled: false,
				reason: `no server url and token configured (${file}, PIKA_URL, PIKA_TOKEN)`,
				file,
				unconfigured: true,
			});
			expect("url" in unconfiguredFile).toBe(false);

			// unconfigured (PIKA_URL without PIKA_TOKEN) in env
			await rm(file);
			const unconfiguredEnv = loadConfig(dir, { PIKA_URL: badUrl });
			expect(unconfiguredEnv).toEqual({
				enabled: false,
				reason: `no server url and token configured (${file}, PIKA_URL, PIKA_TOKEN)`,
				file,
				unconfigured: true,
			});
			expect("url" in unconfiguredEnv).toBe(false);

			for (const result of [disabledFile, disabledEnv, enabledFalseFile, enabledFalseEnv, unconfiguredFile, unconfiguredEnv]) {
				const serialized = JSON.stringify(result);
				expect(serialized).not.toMatch(/dummy-pass-1|dummy-query-1|dummy-frag-1|dummy-mistyped-secret-1|testuser/);
				expect(statusText(result, false, undefined, undefined)).not.toMatch(/dummy-pass-1|dummy-query-1|dummy-frag-1|dummy-mistyped-secret-1|testuser/);
			}
		}

		// Valid URLs on disabled configs are still preserved in normalized form.
		await writeFile(file, JSON.stringify({ url: "https://pika.example.com/pika///", enabled: false }));
		expect(loadConfig(dir, {})).toEqual({ enabled: false, reason: `"enabled" is false in ${file}`, file, url: "https://pika.example.com/pika" });
		expect(loadConfig(dir, { PIKA_DISABLED: "1" })).toEqual({ enabled: false, reason: "PIKA_DISABLED=1 is set", file, url: "https://pika.example.com/pika" });
		await writeFile(file, JSON.stringify({ url: "https://pika.example.com/pika/" }));
		expect(loadConfig(dir, {})).toEqual({
			enabled: false,
			reason: `no server url and token configured (${file}, PIKA_URL, PIKA_TOKEN)`,
			file,
			url: "https://pika.example.com/pika",
			unconfigured: true,
		});
	} finally { await rm(dir, { recursive: true, force: true }); }
});

it("returns a fixed parse-failure reason for malformed pika.json without leaking parser excerpts or secrets", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pika-config-"));
	const file = join(dir, "pika.json");
	const dummyToken = "unquoted_dummy_secret_value";
	try {
		for (const malformed of [
			`{"token": ${dummyToken}}`,
			`{"url": "https://pika.example.com", "token": "${dummyToken}" `,
			`${dummyToken}`,
		]) {
			await writeFile(file, malformed);
			const result = loadConfig(dir, {});
			expect(result).toEqual({ enabled: false, reason: `cannot parse ${file} as JSON; fix or remove it`, file, unreadable: true });
			expect(result.enabled ? "" : result.reason).not.toContain(dummyToken);
			expect(JSON.stringify(result)).not.toContain(dummyToken);
		}
		await rm(file);
		await mkdir(file);
		expect(loadConfig(dir, {})).toEqual({ enabled: false, reason: `cannot read ${file} (EISDIR)`, file, unreadable: true });
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
