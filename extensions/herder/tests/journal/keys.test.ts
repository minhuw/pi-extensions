import { describe, expect, it } from "vitest";
import { hashParts, integrationKey, isStepKey, Occurrences, sha256Hex, stableJson, stepFingerprint, stepId, stepKey } from "../../src/journal/keys.ts";

const input = {
	kind: "agent", role: "worker", roleSha: "r1", prompt: "do it", schema: { type: "object" }, write: true, base: "abc",
	gates: [{ id: "unit", command: "npm test" }],
};

describe("keys", () => {
	it("serializes with sorted keys, no undefined members, and ordered arrays", () => {
		expect(stableJson({ b: 1, a: { d: [3, undefined, 1], c: undefined }, 10: "x", 9: "y" })).toBe('{"10":"x","9":"y","a":{"d":[3,null,1]},"b":1}');
		expect(stableJson({ a: 1, b: 2 })).toBe(stableJson({ b: 2, a: 1 }));
		expect(stableJson(undefined)).toBe("null");
		expect(stableJson(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
	});

	it("hashes parts without separator collisions", () => {
		expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(hashParts("a", "bc")).not.toBe(hashParts("ab", "c"));
		expect(integrationKey("f", "s", "m")).toMatch(/^[0-9a-f]{64}$/);
		expect(integrationKey("f", "s", "m")).not.toBe(integrationKey("f", "s", "m2"));
	});

	it("derives a 12-hex step id from kind, role, and prompt", () => {
		expect(stepId("agent", "worker", "p")).toMatch(/^[0-9a-f]{12}$/);
		expect(stepId("agent", "worker", "p")).toBe(stepId("agent", "worker", "p"));
		expect(stepId("agent", "reviewer", "p")).not.toBe(stepId("agent", "worker", "p"));
	});

	it("keeps the fingerprint stable and sensitive to every identity input", () => {
		const base = stepFingerprint(input);
		expect(stepFingerprint({ ...input, schema: { type: "object" }, gates: [{ id: "unit", command: "npm test", extra: 1 } as { id: string; command: string }] })).toBe(base);
		for (const change of [
			{ prompt: "do it!" }, { base: "abd" }, { roleSha: "r2" }, { schema: { type: "array" } }, { schema: undefined },
			{ gates: [{ id: "unit", command: "npm run test" }] }, { gates: [] }, { write: false }, { role: "resolver" }, { kind: "other" },
		]) expect(stepFingerprint({ ...input, ...change }), JSON.stringify(change)).not.toBe(base);
	});

	it("builds filesystem- and ref-safe step keys", () => {
		expect(stepKey("implement-T1", 0)).toBe("implement-T1_" + sha256Hex("implement-T1").slice(0, 8) + "-0");
		expect(stepKey("impl.t1", 2)).toBe("impl.t1-2");
		expect(stepKey(stepId("agent", "worker", "p"), 0)).toBe(`${stepId("agent", "worker", "p")}-0`);
		const hostile = ["../etc", "a/b", ".hidden", "-flag", "x.lock", "a@{1}", "a\u0000b", "", "a b", "é", "x".repeat(200), "a..b"];
		const keys = hostile.map((id) => stepKey(id, 0));
		for (const key of keys) {
			expect(isStepKey(key), key).toBe(true);
			expect(key).not.toMatch(/\.\.|\/|@\{|[\u0000-\u001f]|^[.-]|\.lock$/);
			expect(key.length).toBeLessThanOrEqual(80);
		}
		expect(new Set(keys).size).toBe(keys.length);
		expect(stepKey("a/b", 0)).not.toBe(stepKey("a_b", 0));
		expect(stepKey("A", 0).toLowerCase()).not.toBe(stepKey("a", 0));
		expect(() => stepKey("a", -1)).toThrow(/occurrence/);
		expect(isStepKey("../x-0")).toBe(false);
	});

	it("counts earlier identical calls per id and fingerprint", () => {
		const occurrences = new Occurrences();
		expect(occurrences.next("a", "f1")).toBe(0);
		expect(occurrences.next("a", "f1")).toBe(1);
		expect(occurrences.next("a", "f2")).toBe(0);
		expect(occurrences.next("b", "f1")).toBe(0);
		expect(occurrences.next("a", "f1")).toBe(2);
		expect(new Occurrences().next("a", "f1")).toBe(0);
	});
});
