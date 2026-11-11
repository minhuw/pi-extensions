import { fingerprint, generateIdentity, type Identity } from "./contract";

/** A node key the user confirmed (NODE.md, "Enrolment" step 4). */
export interface PinnedNode {
	node: string;
	/** The node key's full fingerprint, compared in full. */
	fingerprint: string;
	/** The node key's SPKI (base64url), as its `hs2` carried it. */
	publicKey: string;
	/** The node's name when it was pinned, for display. */
	name: string;
	pinnedAt: number;
}

/** Where this browser profile keeps its client identity and its node pins. */
export interface KeyStore {
	loadIdentity(): Promise<Identity | undefined>;
	saveIdentity(identity: Identity): Promise<void>;
	pins(): Promise<PinnedNode[]>;
	pin(pin: PinnedNode): Promise<void>;
	unpin(node: string): Promise<void>;
}

/** WebCrypto exists only in a secure context (https, or http on localhost). */
export function webCryptoAvailable(): boolean {
	return typeof globalThis.crypto?.subtle?.generateKey === "function";
}

/**
 * The client identity (NODE.md, "Security model"): loaded, or made once with a non-extractable private key. A stored
 * key that is extractable, or whose fingerprint does not match its public key, is refused rather than used.
 */
export async function clientIdentity(store: KeyStore): Promise<Identity> {
	const stored = await store.loadIdentity();
	if (stored) return checked(stored);
	const identity = await generateIdentity();
	if (identity.privateKey.extractable) throw new Error("WebCrypto made an extractable client key.");
	try {
		await store.saveIdentity(identity);
	} catch (cause) {
		// Another tab saved its key first: use that one, so the profile keeps one identity.
		const winner = await store.loadIdentity();
		if (!winner) throw cause;
		return checked(winner);
	}
	return identity;
}

async function checked(stored: Identity): Promise<Identity> {
	if (stored.privateKey.extractable) throw new Error("The stored client key is extractable; refusing to use it.");
	if ((await fingerprint(stored.spki)) !== stored.fingerprint) throw new Error("The stored client key's fingerprint does not match its public key.");
	return stored;
}

const DB_NAME = "pika-nodes";
const DB_VERSION = 1;
const IDENTITY = "identity";
const PINS = "pins";
const CLIENT_KEY = "client";

function promised<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

/**
 * IndexedDB keeps `CryptoKey` objects by structured clone, so the private key never leaves WebCrypto as bytes: the
 * stored object is the same non-extractable key.
 */
export class IndexedDbKeyStore implements KeyStore {
	#db: Promise<IDBDatabase> | undefined;

	#open(): Promise<IDBDatabase> {
		this.#db ??= new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(IDENTITY)) db.createObjectStore(IDENTITY);
				if (!db.objectStoreNames.contains(PINS)) db.createObjectStore(PINS, { keyPath: "node" });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error("IndexedDB failed to open"));
			request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
		});
		return this.#db;
	}

	async #store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
		return (await this.#open()).transaction(name, mode).objectStore(name);
	}

	async loadIdentity(): Promise<Identity | undefined> {
		const value = (await promised((await this.#store(IDENTITY, "readonly")).get(CLIENT_KEY))) as Identity | undefined;
		return value ?? undefined;
	}

	async saveIdentity(identity: Identity): Promise<void> {
		const record: Identity = { publicKey: identity.publicKey, privateKey: identity.privateKey, spki: identity.spki, fingerprint: identity.fingerprint };
		await promised((await this.#store(IDENTITY, "readwrite")).add(record, CLIENT_KEY));
	}

	async pins(): Promise<PinnedNode[]> {
		return (await promised((await this.#store(PINS, "readonly")).getAll())) as PinnedNode[];
	}

	async pin(pin: PinnedNode): Promise<void> {
		await promised((await this.#store(PINS, "readwrite")).put(pin));
	}

	async unpin(node: string): Promise<void> {
		await promised((await this.#store(PINS, "readwrite")).delete(node));
	}
}

/** For tests, and nowhere else: keys and pins in memory. */
export class MemoryKeyStore implements KeyStore {
	identity: Identity | undefined;
	readonly pinned = new Map<string, PinnedNode>();

	async loadIdentity() {
		return this.identity;
	}
	async saveIdentity(identity: Identity) {
		this.identity = identity;
	}
	async pins() {
		return [...this.pinned.values()];
	}
	async pin(pin: PinnedNode) {
		this.pinned.set(pin.node, pin);
	}
	async unpin(node: string) {
		this.pinned.delete(node);
	}
}
