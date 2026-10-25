// Step identity (§6).

export function stableJson(value: unknown): string { throw new Error("not implemented"); }
export function sha256Hex(...parts: string[]): string { throw new Error("not implemented"); }
export function stepId(kind: string, role: string, prompt: string): string { throw new Error("not implemented"); }
export function stepFingerprint(input: { kind: string; role: string; roleSha: string; prompt: string; schema?: object; write: boolean; base: string; gates: Array<{ id: string; command: string }> }): string { throw new Error("not implemented"); }
export function stepKey(id: string, occurrence: number): string { throw new Error("not implemented"); }
export function integrationKey(from: string, source: string, message: string): string { throw new Error("not implemented"); }

/** Counts earlier calls with the same id and fingerprint within one launch. */
export class Occurrences {
	next(id: string, fingerprint: string): number { throw new Error("not implemented"); }
}
