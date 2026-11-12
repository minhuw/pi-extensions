import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Peer } from "../src/daemon.ts";
import { asNodeError, NodeError } from "../src/errors.ts";
import { Files } from "../src/files.ts";
import { toBase64Url, type NodeMessage } from "../src/protocol.ts";
import { tempHome, until } from "./support.ts";

const home = tempHome();
const root = join(home.home, "root");
mkdirSync(join(root, "repo", ".git"), { recursive: true });
mkdirSync(join(root, "plain"), { recursive: true });
const messages: NodeMessage[] = [];
const peer: Peer = { name: "test", closed: false, send: message => { messages.push(message); }, buffered: () => 0 };
const files = new Files({ home: home.home, uploads: join(home.home, "uploads"), config: () => ({ version: 1, roots: [root] }), terminalCwds: () => [], log: () => {} });
afterAll(() => { files.shutdown(); home.cleanup(); });

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const code = async (promise: Promise<unknown>) => {
    try { await promise; return "ok"; }
    catch (error) { return asNodeError(error).code; }
};

describe("files", () => {
    it("lists projects and directories", async () => {
        expect((await files.projects()).map(p => p.name)).toEqual(["repo"]);
        const listing = await files.readDir(root);
        expect(listing).toEqual({ truncated: false, entries: [expect.objectContaining({ name: "plain", kind: "dir" }), expect.objectContaining({ name: "repo", kind: "dir" })] });
        expect(await code(files.readDir(join(root, "missing")))).toBe("not_found");
    });

    it("reads text and binary, and refuses large files", async () => {
        const text = join(root, "a.txt");
        writeFileSync(text, "héllo\n");
        expect(await files.read(text)).toEqual({ encoding: "utf8", data: "héllo\n", stat: expect.objectContaining({ size: 7, hash: sha("héllo\n") }) });
        const binary = join(root, "b.bin");
        writeFileSync(binary, Buffer.from([0, 1, 255]));
        expect(await files.read(binary)).toMatchObject({ encoding: "base64", data: toBase64Url(new Uint8Array([0, 1, 255])) });
        writeFileSync(join(root, "big"), Buffer.alloc(512 * 1024 + 1));
        expect(await code(files.read(join(root, "big")))).toBe("too_large");
        expect(await code(files.read(root))).toBe("is_a_directory");
    });

    it("writes only when unchanged and keeps the mode", async () => {
        const path = join(root, "w.sh");
        expect(await code(files.write(path, Buffer.from("one"), { hash: sha("x") }))).toBe("conflict");
        const created = await files.write(path, Buffer.from("one"), { absent: true }, 0o755);
        expect(statSync(path).mode & 0o777).toBe(0o755);
        expect(await code(files.write(path, Buffer.from("two"), { absent: true }))).toBe("conflict");
        try { await files.write(path, Buffer.from("two"), { hash: sha("stale") }); }
        catch (error) { expect((error as NodeError).current).toMatchObject({ size: 3, hash: sha("one") }); }
        await files.write(path, Buffer.from("two"), { mtimeMs: created.mtimeMs, size: created.size });
        expect(readFileSync(path, "utf8")).toBe("two");
        expect(statSync(path).mode & 0o777).toBe(0o755);
    });

    it("uploads in order, numbers name clashes, and verifies the hash", async () => {
        const body = Buffer.from("upload body");
        const first = await files.uploadStart(peer, "report.pdf", body.length);
        expect(first.path).toMatch(/uploads\/\d{4}-\d{2}-\d{2}\/report\.pdf$/);
        const second = await files.uploadStart(peer, "report.pdf", body.length);
        expect(second.path).toMatch(/report \(2\)\.pdf$/);
        const upload = await files.request(peer, { type: "fs.uploadChunk", id: "1", upload: first.upload, offset: 0, data: toBase64Url(body.subarray(0, 6)) });
        expect(upload).toEqual({ received: 6 });
        expect(await code(files.request(peer, { type: "fs.uploadChunk", id: "2", upload: first.upload, offset: 0, data: toBase64Url(body) }))).toBe("invalid");
        await files.request(peer, { type: "fs.uploadChunk", id: "3", upload: first.upload, offset: 6, data: toBase64Url(body.subarray(6)) });
        expect(await files.request(peer, { type: "fs.uploadFinish", id: "4", upload: first.upload, hash: sha(body) })).toMatchObject({ path: first.path, stat: { size: body.length } });
        expect(readFileSync(first.path, "utf8")).toBe("upload body");
        await files.request(peer, { type: "fs.uploadChunk", id: "5", upload: second.upload, offset: 0, data: toBase64Url(body) });
        expect(await code(files.request(peer, { type: "fs.uploadFinish", id: "6", upload: second.upload, hash: sha("other") }))).toBe("conflict");
        expect(existsSync(second.path)).toBe(false);
    });

    it("watches a file until it is gone", async () => {
        const path = join(root, "watched.txt");
        writeFileSync(path, "1");
        const watch = await files.watch(peer, path);
        // macOS (kqueue) misses a write in the same tick as the watch starts.
        await new Promise(resolve => setTimeout(resolve, 100));
        writeFileSync(path, "2");
        await until(() => messages.some(m => m.type === "fs.changed" && m.watch === watch && m.kind !== "gone"), 5_000, "change event");
        rmSync(path);
        await until(() => messages.some(m => m.type === "fs.changed" && m.watch === watch && m.kind === "gone"), 5_000, "gone event");
        expect(await code(files.request(peer, { type: "fs.unwatch", id: "u", watch }))).toBe("not_found");
    });

    it("keeps watching a file that a rename replaced, as fs.write saves it", async () => {
        const path = join(root, "saved.txt");
        writeFileSync(path, "1");
        const watch = await files.watch(peer, path);
        await new Promise(resolve => setTimeout(resolve, 100));
        const events = () => messages.filter(m => m.type === "fs.changed" && m.watch === watch).length;
        const stat1 = await files.write(path, Buffer.from("2"), { hash: sha("1") });
        await until(() => events() >= 1, 5_000, "first save");
        await new Promise(resolve => setTimeout(resolve, 250));
        const seen = events();
        await files.write(path, Buffer.from("33"), { mtimeMs: stat1.mtimeMs, size: stat1.size });
        await until(() => events() > seen, 5_000, "second save");
        writeFileSync(join(root, ".swap"), "444");
        renameSync(join(root, ".swap"), path);
        const after = events();
        await new Promise(resolve => setTimeout(resolve, 250));
        writeFileSync(path, "5555");
        await until(() => events() > after, 5_000, "write after an external rename");
        expect(messages.some(m => m.type === "fs.changed" && m.watch === watch && m.kind === "gone")).toBe(false);
        await files.request(peer, { type: "fs.unwatch", id: "u2", watch });
    });

    it("shows a file at HEAD and in the index, inside its repository only", async () => {
        const repo = join(home.home, "git");
        mkdirSync(join(repo, "src"), { recursive: true });
        const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
        git("init", "-q");
        writeFileSync(join(repo, "src", "a.ts"), "one\n");
        writeFileSync(join(repo, "gone.txt"), "old\n");
        git("add", ".");
        git("commit", "-qm", "first");
        writeFileSync(join(repo, "src", "a.ts"), "two\n");
        git("add", "src/a.ts");
        writeFileSync(join(repo, "src", "a.ts"), "three\n");
        rmSync(join(repo, "gone.txt"));
        const show = (path: string, ref: "HEAD" | "index") => files.request(peer, { type: "fs.gitShow", id: "g", path, ref });

        expect(await show(join(repo, "src", "a.ts"), "HEAD")).toEqual({ encoding: "utf8", data: "one\n" });
        expect(await show(join(repo, "src", "a.ts"), "index")).toEqual({ encoding: "utf8", data: "two\n" });
        // A deleted file resolves through its parent.
        expect(await show(join(repo, "gone.txt"), "HEAD")).toEqual({ encoding: "utf8", data: "old\n" });
        // Untracked, outside a work tree, and a symlink into another repository.
        writeFileSync(join(repo, "new.txt"), "new");
        expect(await code(show(join(repo, "new.txt"), "HEAD"))).toBe("not_found");
        expect(await code(show(join(root, "a.txt"), "HEAD"))).toBe("not_found");
        const other = join(home.home, "other");
        mkdirSync(other);
        execFileSync("git", ["-C", other, "init", "-q"]);
        writeFileSync(join(other, "secret.txt"), "x");
        symlinkSync(join(other, "secret.txt"), join(repo, "link.txt"));
        git("add", "link.txt");
        // The link's target is in `other`, whose index lacks it: resolved there, never as `link.txt` of this repository.
        expect(await code(show(join(repo, "link.txt"), "index"))).toBe("not_found");
        writeFileSync(join(repo, "big.txt"), "x".repeat(512 * 1024 + 1));
        git("add", "big.txt");
        expect(await code(show(join(repo, "big.txt"), "index"))).toBe("too_large");
    });
});
