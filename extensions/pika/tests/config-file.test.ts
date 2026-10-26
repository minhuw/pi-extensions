import { mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeConfigFile } from "../login.ts";

/** What the mocked `node:fs/promises` saw, and which of its calls fail. */
const fs = vi.hoisted(() => ({ events: [] as string[], failRename: false, failChmod: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: (async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			const sync = handle.sync.bind(handle);
			handle.sync = async () => { fs.events.push("sync"); await sync(); };
			return handle;
		}) as typeof actual.open,
		rename: (async (from, to) => {
			fs.events.push("rename");
			if (fs.failRename) throw Object.assign(new Error("rename failed"), { code: "EIO" });
			await actual.rename(from, to);
		}) as typeof actual.rename,
		chmod: (async (path, mode) => {
			if (path === fs.failChmod) throw Object.assign(new Error("chmod failed"), { code: "EPERM" });
			await actual.chmod(path, mode);
		}) as typeof actual.chmod,
	};
});

let dir: string;
let file: string;
const ORIGINAL = `{ "url": "http://old.example/pika", "token": "old" }\n`;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-pika-file-"));
	file = join(dir, "pika.json");
	await writeFile(file, ORIGINAL, { mode: 0o644 });
	Object.assign(fs, { events: [], failRename: false, failChmod: undefined });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("leaves the original file and no temp file behind when the rename fails", async () => {
	fs.failRename = true;
	await expect(writeConfigFile(file, { url: "http://new.example/pika", token: "new" })).rejects.toThrow("rename failed");
	expect(await readFile(file, "utf8")).toBe(ORIGINAL);
	expect((await stat(file)).mode & 0o777).toBe(0o644);
	expect(await readdir(dir)).toEqual(["pika.json"]);
});

it("syncs the complete temp file before the rename and changes nothing about the file after it", async () => {
	// A failure after the rename would report "Nothing changed" about a file that did change.
	fs.failChmod = file;
	await writeConfigFile(file, { url: "http://new.example/pika", token: "new" });
	expect(fs.events).toEqual(["sync", "rename"]);
	expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ url: "http://new.example/pika", token: "new" });
	expect((await stat(file)).mode & 0o777).toBe(0o600);
	expect(await readdir(dir)).toEqual(["pika.json"]);
});

it("refuses a symbolic link to a missing file and changes nothing", async () => {
	const link = join(dir, "linked.json");
	const target = join(dir, "dotfiles", "pika.json");
	await symlink(target, link);
	await expect(writeConfigFile(link, { url: "http://new.example/pika", token: "new" }))
		.rejects.toThrow(`${link} is a symbolic link to ${target}, which does not exist; fix or remove the link`);
	expect(await readlink(link)).toBe(target);
	expect((await readdir(dir)).sort()).toEqual(["linked.json", "pika.json"]);
	expect(fs.events).toEqual([]);
});
