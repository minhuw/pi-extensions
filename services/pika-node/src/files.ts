/**
 * Projects and files (NODE.md §4 "Projects" and "Files"): directory listings, reads, writes if unchanged,
 * watches, and uploads. Paths are absolute and not limited to the roots: an allowed client already has a shell.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, type Hash } from "node:crypto";
import { existsSync, watch as watchPath, type FSWatcher } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { Peer } from "./daemon.ts";
import { asNodeError, NodeError } from "./errors.ts";
import {
    fromBase64Url, LIMITS, timing, toBase64Url, utf8Length,
    type DirEntry, type Encoding, type Expected, type Project, type Request, type Stat,
} from "./protocol.ts";
import { roots, type Config } from "./store.ts";

const run = promisify(execFile);

interface Watch { id: string; peer: Peer; path: string; file: boolean; watcher: FSWatcher; timer: NodeJS.Timeout | undefined; kind: "change" | "rename" | undefined }
interface Upload { id: string; peer: Peer; path: string; partial: string; size: number; received: number; hash: Hash; idle: NodeJS.Timeout }

export interface FilesOptions {
    home: string;
    /** Default upload directory parent (`~/.pika-node/uploads`). */
    uploads: string;
    config: () => Config;
    terminalCwds: () => string[];
    log: (line: string) => void;
}

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

async function statOf(path: string, withHash: boolean): Promise<Stat | undefined> {
    let info;
    try { info = await stat(path); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    if (info.isDirectory()) throw new NodeError("is_a_directory", `${path} is a directory`);
    const result: Stat = { size: info.size, mtimeMs: Math.floor(info.mtimeMs) };
    if (withHash) result.hash = sha256(await readFile(path));
    return result;
}

function decode(encoding: Encoding, data: string): Buffer {
    if (encoding === "utf8") return Buffer.from(data, "utf8");
    const bytes = fromBase64Url(data);
    if (!bytes) throw new NodeError("invalid", "data is not base64url");
    return Buffer.from(bytes);
}

function isText(data: Buffer): boolean {
    if (data.includes(0)) return false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(data); return true; }
    catch { return false; }
}

const day = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export class Files {
    #options: FilesOptions;
    #watches = new Map<string, Watch>();
    #uploads = new Map<string, Upload>();

    constructor(options: FilesOptions) { this.#options = options; }

    async request(peer: Peer, request: Request): Promise<object> {
        switch (request.type) {
            case "projects.list": return { projects: await this.projects() };
            case "fs.readDir": return this.readDir(request.path);
            case "fs.read": return this.read(request.path);
            case "fs.write": return { stat: await this.write(request.path, decode(request.encoding, request.data), request.expected, request.mode) };
            case "fs.watch": return { watch: await this.watch(peer, request.path) };
            case "fs.gitShow": return this.gitShow(request.path, request.ref);
            case "fs.unwatch": {
                const watch = this.#watches.get(request.watch);
                if (!watch || watch.peer !== peer) throw new NodeError("not_found", `no watch ${request.watch}`);
                this.#endWatch(watch);
                return {};
            }
            case "fs.uploadStart": return this.uploadStart(peer, request.name, request.size, request.dir);
            case "fs.uploadChunk": return this.uploadChunk(this.#upload(peer, request.upload), request.offset, request.data);
            case "fs.uploadFinish": return this.uploadFinish(this.#upload(peer, request.upload), request.hash);
            case "fs.uploadCancel": {
                await this.#cancelUpload(this.#upload(peer, request.upload));
                return {};
            }
            default: throw new NodeError("unsupported", `unknown request ${(request as { type: string }).type}`);
        }
    }

    // -----------------------------------------------------------------------------------------------------------
    // Projects

    async projects(): Promise<Project[]> {
        const config = this.#options.config();
        const candidates: string[] = [...(config.projects ?? [])];
        for (const root of roots(config)) {
            let entries;
            try { entries = await readdir(root, { withFileTypes: true }); }
            catch { continue; }
            for (const entry of entries) if (entry.isDirectory() && existsSync(join(root, entry.name, ".git"))) candidates.push(join(root, entry.name));
        }
        for (const cwd of new Set(this.#options.terminalCwds())) {
            try { candidates.push((await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 2_000 })).stdout.trim()); }
            catch { /* not a repository */ }
        }
        const seen = new Map<string, Project>();
        for (const candidate of candidates) {
            let real: string;
            try { real = await realpath(candidate); }
            catch { continue; }
            if (!seen.has(real)) seen.set(real, { name: basename(real), path: real });
        }
        return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    }

    // -----------------------------------------------------------------------------------------------------------
    // Reads and writes

    async readDir(path: string): Promise<{ entries: DirEntry[]; truncated: boolean }> {
        const info = await stat(path);
        if (!info.isDirectory()) throw new NodeError("not_a_directory", `${path} is not a directory`);
        const names = (await readdir(path)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        const truncated = names.length > LIMITS.maxReadDirEntries;
        const entries: DirEntry[] = [];
        for (const name of names.slice(0, LIMITS.maxReadDirEntries)) {
            try {
                const entry = await lstat(join(path, name));
                const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
                entries.push({ name, kind, size: entry.size, mtimeMs: Math.floor(entry.mtimeMs) });
            } catch { /* vanished while listing */ }
        }
        return { entries, truncated };
    }

    async read(path: string): Promise<{ encoding: Encoding; data: string; stat: Stat }> {
        const info = await stat(path);
        if (info.isDirectory()) throw new NodeError("is_a_directory", `${path} is a directory`);
        if (info.size > LIMITS.maxReadBytes) throw new NodeError("too_large", `${path} is over ${LIMITS.maxReadBytes} bytes`);
        const content = await readFile(path);
        if (content.length > LIMITS.maxReadBytes) throw new NodeError("too_large", `${path} is over ${LIMITS.maxReadBytes} bytes`);
        const text = isText(content);
        const data = text ? content.toString("utf8") : toBase64Url(content);
        if (utf8Length(JSON.stringify(data)) + 1_024 > LIMITS.maxRecordBytes) throw new NodeError("too_large", `${path} does not fit one record`);
        return { encoding: text ? "utf8" : "base64", data, stat: { size: content.length, mtimeMs: Math.floor(info.mtimeMs), hash: sha256(content) } };
    }

    async write(path: string, content: Buffer, expected: Expected, mode?: number): Promise<Stat> {
        const current = await statOf(path, "hash" in expected);
        const matches = "absent" in expected ? current === undefined
            : current !== undefined && ("hash" in expected ? current.hash === expected.hash : current.mtimeMs === expected.mtimeMs && current.size === expected.size);
        if (!matches) {
            const full = current && !current.hash ? await statOf(path, true) : current;
            throw new NodeError("conflict", current ? `${path} changed` : `${path} does not exist`, full);
        }
        const keepMode = current ? (await stat(path)).mode & 0o7777 : mode ?? 0o644;
        const temporary = join(dirname(path), `.${basename(path)}.pika-${randomBytes(6).toString("hex")}.tmp`);
        try {
            await writeFile(temporary, content, { mode: keepMode, flag: "wx" });
            await chmod(temporary, keepMode);
            await rename(temporary, path);
        } catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
        const info = await stat(path);
        return { size: info.size, mtimeMs: Math.floor(info.mtimeMs), hash: sha256(content) };
    }

    // -----------------------------------------------------------------------------------------------------------
    // Watches

    async watch(peer: Peer, path: string): Promise<string> {
        if ([...this.#watches.values()].filter(watch => watch.peer === peer).length >= LIMITS.maxWatchesPerChannel) {
            throw new NodeError("limit", `at most ${LIMITS.maxWatchesPerChannel} watches per channel`);
        }
        const info = await stat(path);
        const id = randomBytes(9).toString("base64url");
        const watch: Watch = { id, peer, path, file: !info.isDirectory(), watcher: undefined as unknown as FSWatcher, timer: undefined, kind: undefined };
        this.#arm(watch);
        this.#watches.set(id, watch);
        return id;
    }

    /**
     * A file watch follows its path, not its inode. kqueue and inotify watch the inode, so a file replaced by a rename
     * (as `fs.write` and most editors save) would go silent after its first event; the watch moves to the new file.
     */
    #arm(watch: Watch): void {
        const watcher = watchPath(watch.path, { persistent: false });
        watch.watcher = watcher;
        watcher.on("change", (event: string) => {
            watch.kind = watch.kind === "rename" || event === "rename" ? "rename" : "change";
            watch.timer ??= setTimeout(() => this.#fire(watch), timing.watchCoalesceMs);
            if (event === "rename" && watch.file && watch.watcher === watcher && existsSync(watch.path)) {
                watcher.close();
                try { this.#arm(watch); }
                catch { /* gone again: the timer reports it */ }
            }
        });
        watcher.on("error", () => this.#fire(watch, true));
    }

    #fire(watch: Watch, failed = false): void {
        watch.timer = undefined;
        if (!this.#watches.has(watch.id)) return;
        const gone = failed || !existsSync(watch.path);
        watch.peer.send({ type: "fs.changed", watch: watch.id, path: watch.path, kind: gone ? "gone" : watch.kind ?? "change" });
        watch.kind = undefined;
        if (gone) this.#endWatch(watch);
    }

    #endWatch(watch: Watch): void {
        this.#watches.delete(watch.id);
        if (watch.timer) clearTimeout(watch.timer);
        watch.watcher.close();
    }

    // -----------------------------------------------------------------------------------------------------------
    // Git

    /**
     * A file's content at `HEAD` or in the index, for diffs. The path's real path must lie inside its repository's real
     * top level, so a symlink cannot name another repository's file; a deleted file resolves through its parent.
     */
    async gitShow(path: string, ref: "HEAD" | "index"): Promise<{ encoding: Encoding; data: string }> {
        let real: string;
        try { real = await realpath(path); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            real = join(await realpath(dirname(path)), basename(path));
        }
        let top: string;
        try { top = await realpath((await run("git", ["-C", dirname(real), "rev-parse", "--show-toplevel"], { timeout: 5_000 })).stdout.trim()); }
        catch { throw new NodeError("not_found", `${path} is not in a git work tree`); }
        const inside = relative(top, real);
        if (!inside || inside === ".." || inside.startsWith(`..${sep}`)) throw new NodeError("outside_roots", `${path} is not inside ${top}`);
        const object = `${ref === "HEAD" ? "HEAD" : ""}:${inside.split(sep).join("/")}`;
        let content: Buffer;
        try {
            content = (await run("git", ["-C", top, "cat-file", "blob", object], { encoding: "buffer", maxBuffer: LIMITS.maxReadBytes, timeout: 10_000 })).stdout;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new NodeError("too_large", `${path} at ${ref} is over ${LIMITS.maxReadBytes} bytes`);
            throw new NodeError("not_found", `${path} is not in ${ref}`);
        }
        const text = isText(content);
        const data = text ? content.toString("utf8") : toBase64Url(content);
        if (utf8Length(JSON.stringify(data)) + 1_024 > LIMITS.maxRecordBytes) throw new NodeError("too_large", `${path} at ${ref} does not fit one record`);
        return { encoding: text ? "utf8" : "base64", data };
    }

    // -----------------------------------------------------------------------------------------------------------
    // Uploads

    #upload(peer: Peer, id: string): Upload {
        const upload = this.#uploads.get(id);
        if (!upload || upload.peer !== peer) throw new NodeError("not_found", `no upload ${id}`);
        upload.idle.refresh();
        return upload;
    }

    async uploadStart(peer: Peer, name: string, size: number, dir?: string): Promise<{ upload: string; path: string }> {
        if (this.#uploads.size >= 64) throw new NodeError("limit", "too many uploads in progress");
        const target = dir ?? join(this.#options.uploads, day(new Date()));
        await mkdir(target, { recursive: true, mode: 0o700 });
        const extension = extname(name);
        const stem = extension ? name.slice(0, -extension.length) : name;
        const id = randomBytes(9).toString("base64url");
        for (let n = 1; n < 1_000; n++) {
            const path = join(target, n === 1 ? name : `${stem} (${n})${extension}`);
            try { await writeFile(path, "", { flag: "wx", mode: 0o600 }); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
                throw error;
            }
            const partial = join(target, `.${basename(path)}.${id}.part`);
            await writeFile(partial, "", { flag: "wx", mode: 0o600 });
            const upload: Upload = { id, peer, path, partial, size, received: 0, hash: createHash("sha256"), idle: setTimeout(() => void this.#cancelUpload(upload), timing.uploadIdleMs) };
            upload.idle.unref();
            this.#uploads.set(id, upload);
            return { upload: id, path };
        }
        throw new NodeError("exists", `too many files named like ${name}`);
    }

    async uploadChunk(upload: Upload, offset: number, data: string): Promise<{ received: number }> {
        if (offset !== upload.received) throw new NodeError("invalid", `offset ${offset} is not ${upload.received}`);
        const bytes = Buffer.from(fromBase64Url(data)!);
        if (upload.received + bytes.length > upload.size) throw new NodeError("too_large", "more data than the announced size");
        upload.received += bytes.length;
        upload.hash.update(bytes);
        const handle = await open(upload.partial, "a");
        try { await handle.write(bytes); }
        finally { await handle.close(); }
        return { received: upload.received };
    }

    async uploadFinish(upload: Upload, hash: string): Promise<{ path: string; stat: Stat }> {
        if (upload.received !== upload.size) throw new NodeError("invalid", `received ${upload.received} of ${upload.size} bytes`);
        const digest = upload.hash.digest("hex");
        if (digest !== hash) {
            await this.#cancelUpload(upload);
            throw new NodeError("conflict", "the upload's SHA-256 does not match");
        }
        this.#uploads.delete(upload.id);
        clearTimeout(upload.idle);
        await rename(upload.partial, upload.path);
        const info = await stat(upload.path);
        return { path: upload.path, stat: { size: info.size, mtimeMs: Math.floor(info.mtimeMs), hash: digest } };
    }

    async #cancelUpload(upload: Upload): Promise<void> {
        if (!this.#uploads.delete(upload.id)) return;
        clearTimeout(upload.idle);
        try {
            await rm(upload.partial, { force: true });
            await rm(upload.path, { force: true });
        } catch (error) { this.#options.log(`upload ${upload.id}: cleanup failed: ${asNodeError(error).message}`); }
    }

    // -----------------------------------------------------------------------------------------------------------

    /** A channel closed: its watches end and its uploads are deleted. */
    closePeer(peer: Peer): void {
        for (const watch of [...this.#watches.values()]) if (watch.peer === peer) this.#endWatch(watch);
        for (const upload of [...this.#uploads.values()]) if (upload.peer === peer) void this.#cancelUpload(upload);
    }

    shutdown(): void {
        for (const watch of [...this.#watches.values()]) this.#endWatch(watch);
        for (const upload of [...this.#uploads.values()]) void this.#cancelUpload(upload);
    }
}
