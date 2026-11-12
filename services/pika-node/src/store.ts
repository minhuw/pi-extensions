/**
 * The node's files: `config.json`, `identity.json`, `clients.json` (allowlist), and `pending.json` (enrolments).
 * Every file is mode 0600 and written atomically. A file that exists but does not parse is an error, never empty.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { exportIdentity, generateIdentity, importIdentity, type Identity, type StoredIdentity } from "./crypto.ts";
import { writeAtomic, type Paths } from "./paths.ts";
import { isAbsolutePath, LIMITS, matchFingerprint, timing, type ClientKey, type ClientsFile, type PendingClient } from "./protocol.ts";

export interface ServerConfig { url: string; credential: string }
export interface Config {
    version: 1;
    server?: ServerConfig;
    roots?: string[];
    /** Projects added by hand (`projects.add`), real paths. */
    projects?: string[];
    /** Projects found on their own (a root's repository, a terminal's) that `projects.remove` hid, real paths. */
    hiddenProjects?: string[];
    /** Real path → the name `projects.rename` gave it. */
    projectNames?: Record<string, string>;
}

export const CREDENTIAL = /^pkn_[A-Za-z0-9_-]{43}$/;

function readJson(path: string): unknown {
    const text = readFileSync(path, "utf8");
    try { return JSON.parse(text) as unknown; }
    catch (error) { throw new Error(`${path} is not valid JSON: ${(error as Error).message}`); }
}

export function loadConfig(p: Paths): Config {
    if (!existsSync(p.config)) return { version: 1 };
    const raw = readJson(p.config) as Partial<Config> | null;
    if (!raw || typeof raw !== "object" || raw.version !== 1) throw new Error(`${p.config}: expected { "version": 1, ... }`);
    const config: Config = { version: 1 };
    if (raw.server !== undefined) {
        const { url, credential } = raw.server as Partial<ServerConfig>;
        if (typeof url !== "string" || !/^https?:\/\/[^/]+/.test(url)) throw new Error(`${p.config}: server.url must be an http(s) URL`);
        if (typeof credential !== "string" || !CREDENTIAL.test(credential)) throw new Error(`${p.config}: server.credential must be a pkn_ node credential`);
        config.server = { url: url.replace(/\/+$/, ""), credential };
    }
    for (const key of ["roots", "projects", "hiddenProjects"] as const) {
        const list = raw[key];
        if (list === undefined) continue;
        if (!Array.isArray(list) || !list.every(item => isAbsolutePath(item))) throw new Error(`${p.config}: ${key} must be a list of absolute paths`);
        config[key] = list as string[];
    }
    if (raw.projectNames !== undefined) {
        const names = raw.projectNames as unknown;
        if (!names || typeof names !== "object" || Array.isArray(names)
            || !Object.entries(names).every(([path, name]) => isAbsolutePath(path) && typeof name === "string" && name.trim().length > 0)) {
            throw new Error(`${p.config}: projectNames must map absolute paths to names`);
        }
        config.projectNames = { ...(names as Record<string, string>) };
    }
    return config;
}

export const saveConfig = (p: Paths, config: Config): void => writeAtomic(p.config, `${JSON.stringify(config, null, 2)}\n`);

/** The configured roots, defaulting to the home directory. */
export const roots = (config: Config): string[] => config.roots ?? [homedir()];

/** Loads the node identity, creating it on first use. */
export async function loadIdentity(p: Paths, create = true): Promise<Identity> {
    if (existsSync(p.identity)) return importIdentity(readJson(p.identity) as StoredIdentity);
    if (!create) throw new Error(`no node identity at ${p.identity}; run \`pika-node start\` or \`pika-node identity\` first`);
    const identity = await generateIdentity({ extractable: true });
    writeAtomic(p.identity, `${JSON.stringify(await exportIdentity(identity))}\n`);
    // Reload so the in-memory private key is non-extractable from now on.
    return importIdentity(readJson(p.identity) as StoredIdentity);
}

// ---------------------------------------------------------------------------------------------------------------
// Allowlist and pending enrolments

export function readClients(p: Paths): ClientsFile {
    if (!existsSync(p.clients)) return { version: 1, clients: [] };
    const raw = readJson(p.clients) as ClientsFile;
    if (raw?.version !== 1 || !Array.isArray(raw.clients)) throw new Error(`${p.clients}: expected { "version": 1, "clients": [...] }`);
    return raw;
}

export function readPending(p: Paths, now = Date.now()): PendingClient[] {
    if (!existsSync(p.pending)) return [];
    const raw = readJson(p.pending) as { version?: number; pending?: PendingClient[] };
    if (raw?.version !== 1 || !Array.isArray(raw.pending)) throw new Error(`${p.pending}: expected { "version": 1, "pending": [...] }`);
    return raw.pending.filter(entry => now - entry.at < timing.pendingEnrolmentMs);
}

const writePending = (p: Paths, pending: PendingClient[]): void => writeAtomic(p.pending, `${JSON.stringify({ version: 1, pending }, null, 2)}\n`);
const writeClients = (p: Paths, file: ClientsFile): void => writeAtomic(p.clients, `${JSON.stringify(file, null, 2)}\n`);

/** Records a client that signed a valid `hs3` but is not allowed; the oldest entry goes first past the cap. */
export function addPending(p: Paths, entry: PendingClient): void {
    const pending = readPending(p, entry.at).filter(row => row.fingerprint !== entry.fingerprint);
    pending.push(entry);
    while (pending.length > LIMITS.maxPendingEnrolments) pending.shift();
    writePending(p, pending);
}

/** `pika-node clients add <prefix>`: moves the one matching pending entry into the allowlist. */
export function allowPending(p: Paths, prefix: string, now = Date.now()): ClientKey {
    const pending = readPending(p, now);
    const matches = matchFingerprint(prefix, pending.map(row => row.fingerprint));
    if (prefix.replace(/\s+/g, "").length < LIMITS.minFingerprintPrefix) throw new Error(`give at least ${LIMITS.minFingerprintPrefix} hex characters of the client fingerprint`);
    if (matches.length === 0) throw new Error("no pending client matches that fingerprint (pending entries expire after 10 minutes; connect again from the browser)");
    if (matches.length > 1) throw new Error("more than one pending client matches; give a longer prefix");
    const entry = pending.find(row => row.fingerprint === matches[0])!;
    const file = readClients(p);
    const key: ClientKey = { fingerprint: entry.fingerprint, publicKey: entry.publicKey, label: entry.label, addedAt: now };
    file.clients = [...file.clients.filter(row => row.fingerprint !== entry.fingerprint), key];
    writeClients(p, file);
    writePending(p, pending.filter(row => row.fingerprint !== entry.fingerprint));
    return key;
}

/** `pika-node clients remove <prefix>`: revokes the one matching allowed key. */
export function removeClient(p: Paths, prefix: string): ClientKey {
    const file = readClients(p);
    const matches = matchFingerprint(prefix, file.clients.map(row => row.fingerprint));
    if (matches.length === 0) throw new Error(`no allowed client matches that fingerprint (give at least ${LIMITS.minFingerprintPrefix} hex characters)`);
    if (matches.length > 1) throw new Error("more than one allowed client matches; give a longer prefix");
    const removed = file.clients.find(row => row.fingerprint === matches[0])!;
    file.clients = file.clients.filter(row => row !== removed);
    writeClients(p, file);
    return removed;
}

/** The allowlist as the daemon sees it, reloaded whenever `clients.json` changes (mtime, size, or inode). */
export class Allowlist {
    #p: Paths;
    #stamp = "";
    #allowed = new Set<string>();
    /** Why the file could not be read; every client is denied until it is fixed. */
    error: string | undefined;
    constructor(p: Paths) { this.#p = p; this.reload(); }

    /** Rereads the file when it changed; true when the set of keys may have changed. A broken file denies everyone. */
    reload(): boolean {
        let stamp = "absent";
        try {
            const stat = statSync(this.#p.clients);
            stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
        } catch { /* absent */ }
        if (stamp === this.#stamp) return false;
        this.#stamp = stamp;
        try {
            this.#allowed = new Set(readClients(this.#p).clients.map(row => row.fingerprint));
            this.error = undefined;
        } catch (error) {
            this.#allowed = new Set();
            this.error = (error as Error).message;
        }
        return true;
    }

    has(fingerprint: string): boolean { return this.#allowed.has(fingerprint); }
}
