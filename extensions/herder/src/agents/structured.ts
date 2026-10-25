import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import { STRUCTURED_OUTPUT_REJECTIONS, STRUCTURED_OUTPUT_TOOL } from "../config.ts";

const MAX_MESSAGES = 8;

/** Problems with a schema itself; empty when it can be a `StructuredOutput` tool's input schema. */
export function checkSchema(schema: unknown): string[] {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return ["schema must be a JSON Schema object"];
	if ((schema as { type?: unknown }).type !== "object") return ['schema must have type: "object" at its root'];
	try { Check(schema, {}); } catch (error) { return [`schema cannot be validated: ${error instanceof Error ? error.message : String(error)}`]; }
	return [];
}

/** Validation messages for `value` against a JSON Schema; empty when valid. */
export function validateSchema(schema: object, value: unknown): string[] {
	try {
		if (Check(schema, value)) return [];
		const messages: string[] = [];
		for (const error of Errors(schema, value)) {
			const path = String(error.instancePath ?? "");
			messages.push(`${path ? `$${path.replace(/\//g, ".")}` : "$"}: ${error.message}`);
			if (messages.length >= MAX_MESSAGES) break;
		}
		return messages.length ? messages : ["$: value does not match the schema"];
	} catch (error) {
		return [`$: value could not be validated: ${error instanceof Error ? error.message : String(error)}`];
	}
}

/** What the agent reported through `StructuredOutput`; the runner counts rejections from tool events. */
export interface StructuredCapture { accepted: boolean; data?: unknown; rejections: number; lastError?: string }

/** Pi validates arguments against `parameters` before `execute`; validating again keeps our messages and checks authoritative. */
export function createStructuredOutputTool(schema: object, capture: StructuredCapture): ToolDefinition {
	return defineTool({
		name: STRUCTURED_OUTPUT_TOOL,
		label: "Structured Output",
		description: "Report your final answer as structured data matching the required schema. Text outside this call is not recorded. If a call is rejected, fix the reported problems and call it again.",
		promptSnippet: "Report your final answer as structured data",
		promptGuidelines: [`Your final answer MUST be reported by calling ${STRUCTURED_OUTPUT_TOOL}. Prose outside that call is not recorded.`],
		parameters: schema as never,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		prepareArguments: (args: unknown) => {
			if (typeof args !== "string") return args as never;
			try { return JSON.parse(args) as never; } catch { return args as never; }
		},
		execute: async (_id, params) => {
			const problems = validateSchema(schema, params);
			if (problems.length) {
				return { content: [{ type: "text", text: `${STRUCTURED_OUTPUT_TOOL} rejected the payload:\n${problems.map((line) => `- ${line}`).join("\n")}\nCall it again with a corrected value.` }], isError: true, details: {} };
			}
			capture.accepted = true;
			capture.data = params;
			return { content: [{ type: "text", text: "Recorded. End your turn now." }], details: {} };
		},
	}) as ToolDefinition;
}

/** Re-prompt sent when a run ends without an accepted payload. */
export function structuredReminder(capture: StructuredCapture): string {
	const reason = capture.lastError ? `Your last ${STRUCTURED_OUTPUT_TOOL} call was rejected:\n${capture.lastError}` : `You did not call ${STRUCTURED_OUTPUT_TOOL}, so your answer was not recorded.`;
	return `${reason}\n\nCall ${STRUCTURED_OUTPUT_TOOL} now with your complete final answer (${STRUCTURED_OUTPUT_REJECTIONS - capture.rejections} attempt(s) left).`;
}
