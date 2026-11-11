/**
 * The end-to-end channel layer of NODE.md §3 on WebCrypto alone (Node ≥ 22 and browsers): identities and
 * fingerprints, the signed ECDH handshake, and AES-256-GCM records with per-direction counters.
 */
import {
    fromBase64Url, LIMITS, PROTOCOL_VERSION, toBase64Url, utf8Length,
    type ChannelCloseCode, type Hs1, type Hs2, type Hs3, type Rec,
} from "./protocol.ts";

type Bytes = Uint8Array<ArrayBuffer>;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const encoder = new TextEncoder();
const utf8 = (text: string): Bytes => encoder.encode(text) as Bytes;

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

const HANDSHAKE_LABEL = "pika-node/1 handshake";
const NODE_SIG = "pika-node/1 node-sig";
const CLIENT_SIG = "pika-node/1 client-sig";
const C2N = "pika-node/1 c2n";
const N2C = "pika-node/1 n2c";
const AAD = "pika-node/1 rec|";

/** A failure that ends the channel; `code` is the channel close code to send. */
export class ChannelError extends Error {
    readonly code: ChannelCloseCode;
    constructor(code: ChannelCloseCode, message: string = code) {
        super(message);
        this.code = code;
    }
}

export interface Identity { publicKey: CryptoKey; privateKey: CryptoKey; spki: Bytes; fingerprint: string }
/** A node's `identity.json`. */
export interface StoredIdentity { version: 1; publicKey: string; privateKey: JsonWebKey }

function concat(...parts: Uint8Array[]): Bytes {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** `lp(x)`: a 4-byte big-endian length, then the bytes. */
function lp(part: Uint8Array | string): Bytes {
    const bytes = typeof part === "string" ? utf8(part) : part;
    const out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint32(0, bytes.length);
    out.set(bytes, 4);
    return out;
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");

/** Lowercase hex SHA-256 of a public key's SPKI DER. */
export async function fingerprint(spki: Uint8Array): Promise<string> {
    return hex(await subtle().digest("SHA-256", new Uint8Array(spki)));
}

/** A new ECDSA P-256 identity. Browsers keep the default `extractable: false`; a node needs true to store its key once. */
export async function generateIdentity(options: { extractable?: boolean } = {}): Promise<Identity> {
    const pair = await subtle().generateKey(ECDSA, options.extractable ?? false, ["sign", "verify"]);
    const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
    return { publicKey: pair.publicKey, privateKey: pair.privateKey, spki, fingerprint: await fingerprint(spki) };
}

export async function exportIdentity(identity: Identity): Promise<StoredIdentity> {
    return { version: 1, publicKey: toBase64Url(identity.spki), privateKey: await subtle().exportKey("jwk", identity.privateKey) };
}

/** Loads a stored identity with a non-extractable private key; throws when the two halves do not belong together. */
export async function importIdentity(stored: StoredIdentity): Promise<Identity> {
    const spki = fromBase64Url(stored.publicKey);
    if (stored.version !== 1 || !spki) throw new Error("invalid stored identity");
    const publicKey = await subtle().importKey("spki", spki, ECDSA, true, ["verify"]);
    const privateKey = await subtle().importKey("jwk", stored.privateKey, ECDSA, false, ["sign"]);
    const probe = utf8("pika-node/1 identity-check");
    if (!await subtle().verify(SIGN, publicKey, await subtle().sign(SIGN, privateKey, probe), probe)) throw new Error("stored identity keys do not match");
    return { publicKey, privateKey, spki, fingerprint: await fingerprint(spki) };
}

/** The server-assigned ids every transcript binds. */
export interface ChannelIds { channel: string; node: string }

async function verifyKey(spkiText: string): Promise<{ key: CryptoKey; spki: Bytes }> {
    const spki = fromBase64Url(spkiText);
    if (!spki) throw new ChannelError("handshake_failed", "bad public key encoding");
    try { return { key: await subtle().importKey("spki", spki, ECDSA, true, ["verify"]), spki }; }
    catch { throw new ChannelError("handshake_failed", "invalid public key"); }
}

async function peerEph(text: string): Promise<CryptoKey> {
    const raw = fromBase64Url(text);
    if (!raw || raw.length !== 65) throw new ChannelError("handshake_failed", "bad ephemeral key encoding");
    try { return await subtle().importKey("raw", raw, ECDH, true, []); }
    catch { throw new ChannelError("handshake_failed", "invalid ephemeral key"); }
}

async function transcript(ids: ChannelIds, clientKey: Bytes, clientEph: Bytes, label: string, nodeKey: Bytes, nodeEph: Bytes): Promise<Bytes> {
    const input = concat(lp(HANDSHAKE_LABEL), lp(ids.channel), lp(ids.node), lp(clientKey), lp(clientEph), lp(label), lp(nodeKey), lp(nodeEph));
    return new Uint8Array(await subtle().digest("SHA-256", input));
}

async function sign(identity: Identity, label: string, th: Bytes): Promise<string> {
    return toBase64Url(new Uint8Array(await subtle().sign(SIGN, identity.privateKey, concat(utf8(label), th))));
}

async function verify(key: CryptoKey, label: string, th: Bytes, sigText: string): Promise<boolean> {
    const sig = fromBase64Url(sigText);
    if (!sig || sig.length !== 64) return false;
    return subtle().verify(SIGN, key, sig, concat(utf8(label), th));
}

async function ephemeral(): Promise<{ pair: CryptoKeyPair; raw: Bytes }> {
    const pair = await subtle().generateKey(ECDH, false, ["deriveBits"]);
    return { pair, raw: new Uint8Array(await subtle().exportKey("raw", pair.publicKey)) };
}

async function deriveSession(side: "client" | "node", ids: ChannelIds, ownEph: CryptoKey, peer: CryptoKey, th: Bytes): Promise<Session> {
    const shared = await subtle().deriveBits({ name: "ECDH", public: peer }, ownEph, 256);
    const base = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const derive = (info: string, usage: KeyUsage) =>
        subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: th, info: utf8(info) }, base, { name: "AES-GCM", length: 256 }, false, [usage]);
    const [send, receive] = side === "client"
        ? await Promise.all([derive(C2N, "encrypt"), derive(N2C, "decrypt")])
        : await Promise.all([derive(N2C, "encrypt"), derive(C2N, "decrypt")]);
    return new Session(ids.channel, send, receive);
}

// ---------------------------------------------------------------------------------------------------------------
// Handshake

export interface ClientPending { ids: ChannelIds; identity: Identity; eph: CryptoKeyPair; ephRaw: Bytes; label: string; hs1: Hs1 }
export interface NodePending { ids: ChannelIds; clientKey: CryptoKey; clientSpki: Bytes; clientFingerprint: string; label: string; eph: CryptoKeyPair; peer: CryptoKey; th: Bytes }

/** Step 1 (client): `hs1`. */
export async function startHandshake(identity: Identity, ids: ChannelIds, label?: string): Promise<ClientPending> {
    const { pair, raw } = await ephemeral();
    const hs1: Hs1 = { t: "hs1", v: PROTOCOL_VERSION, clientKey: toBase64Url(identity.spki), eph: toBase64Url(raw), ...(label ? { label } : {}) };
    return { ids, identity, eph: pair, ephRaw: raw, label: label ?? "", hs1 };
}

/** Step 2 (node): verifies the version, answers `hs2`. Throws `ChannelError` (`unsupported_version`, `handshake_failed`). */
export async function answerHandshake(identity: Identity, ids: ChannelIds, hs1: Hs1): Promise<{ hs2: Hs2; pending: NodePending }> {
    if (hs1.v !== PROTOCOL_VERSION) throw new ChannelError("unsupported_version", `unsupported version ${hs1.v}`);
    const client = await verifyKey(hs1.clientKey);
    const peer = await peerEph(hs1.eph);
    const clientEph = fromBase64Url(hs1.eph)!;
    const label = hs1.label ?? "";
    const { pair, raw } = await ephemeral();
    const th = await transcript(ids, client.spki, clientEph, label, identity.spki, raw);
    const hs2: Hs2 = { t: "hs2", v: PROTOCOL_VERSION, nodeKey: toBase64Url(identity.spki), eph: toBase64Url(raw), sig: await sign(identity, NODE_SIG, th) };
    return { hs2, pending: { ids, clientKey: client.key, clientSpki: client.spki, clientFingerprint: await fingerprint(client.spki), label, eph: pair, peer, th } };
}

/**
 * Step 3 (client): verifies the node's signature and, when `pinned` is given, its fingerprint (`node_key_changed`).
 * Without a pin the caller may send `hs3` only to enrol, and no inner message until the user confirms `nodeFingerprint`.
 */
export async function finishClientHandshake(pending: ClientPending, hs2: Hs2, pinned?: string): Promise<{ hs3: Hs3; session: Session; nodeKey: string; nodeFingerprint: string }> {
    if (hs2.v !== PROTOCOL_VERSION) throw new ChannelError("unsupported_version", `unsupported version ${hs2.v}`);
    const node = await verifyKey(hs2.nodeKey);
    const nodeFingerprint = await fingerprint(node.spki);
    if (pinned !== undefined && pinned !== nodeFingerprint) throw new ChannelError("node_key_changed", `node key ${nodeFingerprint} is not the pinned ${pinned}`);
    const peer = await peerEph(hs2.eph);
    const th = await transcript(pending.ids, pending.identity.spki, pending.ephRaw, pending.label, node.spki, fromBase64Url(hs2.eph)!);
    if (!await verify(node.key, NODE_SIG, th, hs2.sig)) throw new ChannelError("handshake_failed", "bad node signature");
    const hs3: Hs3 = { t: "hs3", sig: await sign(pending.identity, CLIENT_SIG, th) };
    return { hs3, session: await deriveSession("client", pending.ids, pending.eph.privateKey, peer, th), nodeKey: hs2.nodeKey, nodeFingerprint };
}

/** Step 4 (node): verifies the client's signature. The allowlist check is the caller's, with `clientFingerprint`. */
export async function finishNodeHandshake(pending: NodePending, hs3: Hs3): Promise<{ session: Session; clientFingerprint: string }> {
    if (!await verify(pending.clientKey, CLIENT_SIG, pending.th, hs3.sig)) throw new ChannelError("handshake_failed", "bad client signature");
    return { session: await deriveSession("node", pending.ids, pending.eph.privateKey, pending.peer, pending.th), clientFingerprint: pending.clientFingerprint };
}

// ---------------------------------------------------------------------------------------------------------------
// Records

function iv(n: number): Bytes {
    const out = new Uint8Array(12);
    new DataView(out.buffer).setBigUint64(4, BigInt(n));
    return out;
}

/**
 * One channel's record layer. `seal` and `open` resolve in call order, so a caller may send each record as soon as
 * its promise resolves. Any failure is final: every later call rejects with the same code.
 */
export class Session {
    readonly channel: string;
    #send: CryptoKey;
    #receive: CryptoKey;
    #aad: Bytes;
    #sent = 0;
    #received = 0;
    #failed: ChannelCloseCode | undefined;
    #sendTail: Promise<unknown> = Promise.resolve();
    #receiveTail: Promise<unknown> = Promise.resolve();

    constructor(channel: string, send: CryptoKey, receive: CryptoKey) {
        this.channel = channel;
        this.#send = send;
        this.#receive = receive;
        this.#aad = utf8(AAD + channel);
    }

    get failed(): ChannelCloseCode | undefined { return this.#failed; }

    #fail(code: ChannelCloseCode, message?: string): never {
        this.#failed ??= code;
        throw new ChannelError(this.#failed, message);
    }

    /** Encrypts one inner message (its JSON text). */
    seal(plaintext: string): Promise<Rec> {
        try {
            if (this.#failed) this.#fail(this.#failed);
            if (utf8Length(plaintext) > LIMITS.maxRecordBytes) throw new ChannelError("too_large", "record over the size limit");
            if (this.#sent >= LIMITS.maxRecords) this.#fail("rekey_required");
        } catch (error) { return Promise.reject(error); }
        const n = this.#sent++;
        const result = this.#sendTail.then(async (): Promise<Rec> => {
            const ct = await subtle().encrypt({ name: "AES-GCM", iv: iv(n), additionalData: this.#aad }, this.#send, utf8(plaintext));
            return { t: "rec", n, ct: toBase64Url(new Uint8Array(ct)) };
        });
        this.#sendTail = result.catch(() => undefined);
        return result;
    }

    /** Decrypts the next record; `replay`, `out_of_order`, and `decrypt_failed` end the session. */
    open(rec: Rec): Promise<string> {
        try {
            if (this.#failed) this.#fail(this.#failed);
            if (rec.n < this.#received) this.#fail("replay", `record ${rec.n} was already received`);
            if (rec.n > this.#received) this.#fail("out_of_order", `expected record ${this.#received}, got ${rec.n}`);
        } catch (error) { return Promise.reject(error); }
        this.#received++;
        const result = this.#receiveTail.then(async (): Promise<string> => {
            if (this.#failed) this.#fail(this.#failed);
            const ct = fromBase64Url(rec.ct);
            if (!ct) this.#fail("decrypt_failed", "bad ciphertext encoding");
            let plain: ArrayBuffer;
            try { plain = await subtle().decrypt({ name: "AES-GCM", iv: iv(rec.n), additionalData: this.#aad }, this.#receive, ct); }
            catch { this.#fail("decrypt_failed", "record failed authentication"); }
            try { return new TextDecoder("utf-8", { fatal: true }).decode(plain); }
            catch { this.#fail("decrypt_failed", "record is not UTF-8"); }
        });
        this.#receiveTail = result.catch(() => undefined);
        return result;
    }
}
