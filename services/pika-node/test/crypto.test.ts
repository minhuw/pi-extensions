import { describe, expect, it } from "vitest";
import {
    answerHandshake, ChannelError, exportIdentity, finishClientHandshake, finishNodeHandshake, fingerprint, generateIdentity,
    importIdentity, startHandshake, type Identity,
} from "../src/crypto.ts";
import { fromBase64Url, LIMITS, parseChannelBody, toBase64Url, type Rec } from "../src/protocol.ts";

const ids = { channel: "ch_1", node: "node-1" };

async function pair(options: { client?: Identity; node?: Identity; nodeIds?: typeof ids } = {}) {
    const client = options.client ?? await generateIdentity();
    const node = options.node ?? await generateIdentity({ extractable: true });
    const pending = await startHandshake(client, ids, "test browser");
    // Every body goes through the wire parser, as the peer would receive it.
    expect(parseChannelBody(JSON.parse(JSON.stringify(pending.hs1))).ok).toBe(true);
    const { hs2, pending: nodePending } = await answerHandshake(node, options.nodeIds ?? ids, pending.hs1);
    expect(parseChannelBody(hs2).ok).toBe(true);
    const finished = await finishClientHandshake(pending, hs2, node.fingerprint);
    expect(parseChannelBody(finished.hs3).ok).toBe(true);
    const nodeSide = await finishNodeHandshake(nodePending, finished.hs3);
    return { client, node, clientSession: finished.session, nodeSession: nodeSide.session, clientFingerprint: nodeSide.clientFingerprint, nodeFingerprint: finished.nodeFingerprint };
}

const code = async (promise: Promise<unknown>) => {
    try { await promise; }
    catch (error) { return error instanceof ChannelError ? error.code : `not a ChannelError: ${String(error)}`; }
    return "resolved";
};

function flip(rec: Rec): Rec {
    const bytes = fromBase64Url(rec.ct)!;
    bytes[0]! ^= 1;
    return { ...rec, ct: toBase64Url(bytes) };
}

describe("identities", () => {
    it("fingerprints the SPKI and keeps browser keys non-extractable", async () => {
        const identity = await generateIdentity();
        expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(identity.fingerprint).toBe(await fingerprint(identity.spki));
        expect(identity.privateKey.extractable).toBe(false);
        await expect(exportIdentity(identity)).rejects.toThrow();
    });

    it("stores and reloads a node identity", async () => {
        const node = await generateIdentity({ extractable: true });
        const stored = JSON.parse(JSON.stringify(await exportIdentity(node)));
        const loaded = await importIdentity(stored);
        expect(loaded.fingerprint).toBe(node.fingerprint);
        expect(loaded.privateKey.extractable).toBe(false);
        const other = await exportIdentity(await generateIdentity({ extractable: true }));
        await expect(importIdentity({ ...stored, privateKey: other.privateKey })).rejects.toThrow("do not match");
    });
});

describe("handshake and records", () => {
    it("agrees on keys both ways and reports both fingerprints", async () => {
        const { client, node, clientSession, nodeSession, clientFingerprint, nodeFingerprint } = await pair();
        expect(clientFingerprint).toBe(client.fingerprint);
        expect(nodeFingerprint).toBe(node.fingerprint);
        const rec = await nodeSession.seal('{"type":"welcome"}');
        expect(parseChannelBody(rec).ok).toBe(true);
        expect(await clientSession.open(rec)).toBe('{"type":"welcome"}');
        for (const text of ["a", "日本語 😀", "x".repeat(100_000)]) expect(await nodeSession.open(await clientSession.seal(text))).toBe(text);
    });

    it("seals and opens in call order", async () => {
        const { clientSession, nodeSession } = await pair();
        const recs = await Promise.all(Array.from({ length: 20 }, (_, i) => clientSession.seal(`m${i}`)));
        expect(recs.map(rec => rec.n)).toEqual([...Array(20).keys()]);
        expect(await Promise.all(recs.map(rec => nodeSession.open(rec)))).toEqual(recs.map((_, i) => `m${i}`));
    });

    it("rejects replay, reordering, and tampering, and stays failed", async () => {
        const replay = await pair();
        const first = await replay.clientSession.seal("one");
        await replay.nodeSession.open(first);
        expect(await code(replay.nodeSession.open(first))).toBe("replay");
        expect(await code(replay.nodeSession.open(await replay.clientSession.seal("two")))).toBe("replay");

        const reorder = await pair();
        await reorder.clientSession.seal("zero");
        expect(await code(reorder.nodeSession.open(await reorder.clientSession.seal("one")))).toBe("out_of_order");

        const tamper = await pair();
        expect(await code(tamper.nodeSession.open(flip(await tamper.clientSession.seal("one"))))).toBe("decrypt_failed");
        expect(await code(tamper.nodeSession.open(await tamper.clientSession.seal("two")))).toBe("decrypt_failed");
        expect(tamper.nodeSession.failed).toBe("decrypt_failed");
    });

    it("rejects a record reflected back to its sender and a record from another channel", async () => {
        const a = await pair();
        const b = await pair({ client: a.client, node: a.node });
        expect(await code(b.nodeSession.open(await a.clientSession.seal("other")))).toBe("decrypt_failed");
        const echo = await a.clientSession.seal("echo");
        expect(await code(a.clientSession.open({ ...echo, n: 0 }))).toBe("decrypt_failed");
    });

    it("refuses oversized plaintext without failing the session", async () => {
        const { clientSession, nodeSession } = await pair();
        expect(await code(clientSession.seal("x".repeat(LIMITS.maxRecordBytes + 1)))).toBe("too_large");
        expect(await nodeSession.open(await clientSession.seal("fine"))).toBe("fine");
    });
});

describe("handshake failures", () => {
    it("refuses a node key that is not the pinned one", async () => {
        const client = await generateIdentity();
        const pending = await startHandshake(client, ids);
        const { hs2 } = await answerHandshake(await generateIdentity({ extractable: true }), ids, pending.hs1);
        expect(await code(finishClientHandshake(pending, hs2, "0".repeat(64)))).toBe("node_key_changed");
    });

    it("returns the node fingerprint for confirmation when nothing is pinned", async () => {
        const node = await generateIdentity({ extractable: true });
        const pending = await startHandshake(await generateIdentity(), ids);
        const { hs2 } = await answerHandshake(node, ids, pending.hs1);
        expect((await finishClientHandshake(pending, hs2)).nodeFingerprint).toBe(node.fingerprint);
    });

    it("fails when a server substitutes its own node key", async () => {
        const client = await generateIdentity();
        const node = await generateIdentity({ extractable: true });
        const server = await generateIdentity({ extractable: true });
        const pending = await startHandshake(client, ids);
        const { hs2 } = await answerHandshake(node, ids, pending.hs1);
        // The real signature under a substituted key fails even without a pin.
        expect(await code(finishClientHandshake(pending, { ...hs2, nodeKey: toBase64Url(server.spki) }))).toBe("handshake_failed");
        // Answering as itself is caught by the pin.
        const { hs2: forged } = await answerHandshake(server, ids, pending.hs1);
        expect(await code(finishClientHandshake(pending, forged, node.fingerprint))).toBe("node_key_changed");
    });

    it("binds the transcript to the channel and node ids", async () => {
        const node = await generateIdentity({ extractable: true });
        const pending = await startHandshake(await generateIdentity(), ids);
        const { hs2 } = await answerHandshake(node, { ...ids, channel: "ch_2" }, pending.hs1);
        expect(await code(finishClientHandshake(pending, hs2, node.fingerprint))).toBe("handshake_failed");
    });

    it("fails on a swapped ephemeral key or a bad client signature", async () => {
        const node = await generateIdentity({ extractable: true });
        const pending = await startHandshake(await generateIdentity(), ids);
        const { hs2, pending: nodePending } = await answerHandshake(node, ids, pending.hs1);
        const other = await startHandshake(await generateIdentity(), ids);
        expect(await code(finishClientHandshake(pending, { ...hs2, eph: other.hs1.eph }, node.fingerprint))).toBe("handshake_failed");

        // A garbage signature, and a valid hs3 from another handshake of the same client, both fail.
        expect(await code(finishNodeHandshake(nodePending, { t: "hs3", sig: toBase64Url(new Uint8Array(64)) }))).toBe("handshake_failed");
        const again = await startHandshake(pending.identity, ids);
        const { hs2: hs2Again } = await answerHandshake(node, ids, again.hs1);
        const { hs3 } = await finishClientHandshake(again, hs2Again, node.fingerprint);
        expect(await code(finishNodeHandshake(nodePending, hs3))).toBe("handshake_failed");
    });

    it("refuses another protocol version and invalid keys", async () => {
        const node = await generateIdentity({ extractable: true });
        const pending = await startHandshake(await generateIdentity(), ids);
        expect(await code(answerHandshake(node, ids, { ...pending.hs1, v: 2 }))).toBe("unsupported_version");
        expect(await code(answerHandshake(node, ids, { ...pending.hs1, eph: toBase64Url(new Uint8Array(65).fill(4)) }))).toBe("handshake_failed");
        expect(await code(answerHandshake(node, ids, { ...pending.hs1, clientKey: toBase64Url(new Uint8Array(91)) }))).toBe("handshake_failed");
    });
});
