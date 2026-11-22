import { createHash } from "node:crypto";

const LONG_STRING = 2048;

export interface SplitPayload {
	skeleton: unknown;
	/** Every referenced hash, in order of first appearance. */
	blocks: string[];
	/** Block text by hash. */
	data: Map<string, string>;
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Splits a JSON-round-tripped payload: each element of a top-level array becomes a block, and so
 * does each top-level string longer than 2048 characters. Everything else stays in the skeleton.
 */
export function splitPayload(payload: unknown): SplitPayload {
	const blocks: string[] = [];
	const data = new Map<string, string>();
	const add = (text: string) => {
		const hash = sha256(text);
		if (!data.has(hash)) { data.set(hash, text); blocks.push(hash); }
		return hash;
	};
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { skeleton: payload ?? null, blocks, data };
	}
	const skeleton: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
		if (Array.isArray(value)) skeleton[key] = value.map((element) => ({ $pika: add(JSON.stringify(element)) }));
		else if (typeof value === "string" && value.length > LONG_STRING) skeleton[key] = { $pika: add(value), $type: "string" };
		else skeleton[key] = value;
	}
	return { skeleton, blocks, data };
}
