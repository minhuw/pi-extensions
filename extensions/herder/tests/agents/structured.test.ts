import { describe, expect, it } from "vitest";
import { checkSchema, createStructuredOutputTool, validateSchema, type StructuredCapture } from "../../src/agents/structured.ts";

const schema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["met", "not_met"] },
		items: { type: "array", items: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"] } },
		note: { anyOf: [{ type: "string" }, { type: "null" }] },
	},
	required: ["status", "items"],
	additionalProperties: false,
};

describe("validateSchema", () => {
	it("returns no messages for a valid value", () => {
		expect(validateSchema(schema, { status: "met", items: [{ id: "a" }], note: null })).toEqual([]);
	});

	it("reports each problem with a $-path", () => {
		const messages = validateSchema(schema, { status: "maybe", items: [{ id: "" }, {}], extra: 1 });
		expect(messages.length).toBeGreaterThanOrEqual(3);
		expect(messages.join("\n")).toMatch(/^\$/m);
		expect(messages.some((line) => line.startsWith("$.status"))).toBe(true);
		expect(messages.some((line) => line.startsWith("$.items.0.id"))).toBe(true);
		expect(validateSchema(schema, "not an object")).not.toEqual([]);
	});
});

describe("checkSchema", () => {
	it("accepts object schemas and rejects others", () => {
		expect(checkSchema(schema)).toEqual([]);
		expect(checkSchema({ type: "array" })).toEqual(['schema must have type: "object" at its root']);
		expect(checkSchema(null)).toEqual(["schema must be a JSON Schema object"]);
	});
});

describe("StructuredOutput tool", () => {
	it("records a valid payload and rejects an invalid one as a tool error", async () => {
		const capture: StructuredCapture = { accepted: false, rejections: 0 };
		const tool = createStructuredOutputTool(schema, capture);
		expect(tool.name).toBe("StructuredOutput");
		const call = (params: unknown) => tool.execute("id", params as never, undefined, undefined, undefined as never);
		const bad = await call({ status: "met" });
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.content)).toContain("$");
		expect(capture.accepted).toBe(false);
		const good = await call({ status: "met", items: [] });
		expect(good.isError).toBeUndefined();
		expect(capture).toMatchObject({ accepted: true, data: { status: "met", items: [] } });
		expect(tool.prepareArguments?.('{"status":"met","items":[]}')).toEqual({ status: "met", items: [] });
	});
});
