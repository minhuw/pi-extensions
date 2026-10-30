import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { Type, type Static } from "typebox";

export const QuestionSchema = Type.Object({
	questions: Type.Array(Type.Object({
		id: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" }),
		question: Type.String({ minLength: 1, maxLength: 2000 }),
		description: Type.Optional(Type.String({ maxLength: 4000 })),
		choices: Type.Optional(Type.Array(Type.Object({
			id: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" }),
			label: Type.String({ minLength: 1, maxLength: 200 }),
			description: Type.Optional(Type.String({ maxLength: 1000 })),
		}), { minItems: 1, maxItems: 10 })),
		allowFreeText: Type.Optional(Type.Boolean({ description: "Offer a custom answer alongside choices" })),
	}), { minItems: 1, maxItems: 5 }),
});

const QuestionResultSchema = Type.Object({
	status: Type.Union([Type.Literal("answered"), Type.Literal("dismissed"), Type.Literal("cancelled"), Type.Literal("unavailable")]),
	answers: Type.Array(Type.Object({ id: Type.String(), value: Type.String(), choiceId: Type.Optional(Type.String()) })),
	pending: Type.Array(QuestionSchema.properties.questions.items),
	message: Type.String(),
});

type Request = Static<typeof QuestionSchema>;
export type QuestionReport = {
	status: "answered" | "dismissed" | "cancelled" | "unavailable";
	answers: Array<{ id: string; value: string; choiceId?: string }>;
	pending: Request["questions"];
	message: string;
};

/** Validate the whole batch before opening any dialog, including cross-item constraints. */
function validate(request: Request): void {
	if (!Check(QuestionSchema, request)) throw new Error("Invalid structured question batch.");
	if (!Array.isArray(request.questions) || request.questions.length < 1 || request.questions.length > 5) {
		throw new Error("Provide one to five related questions.");
	}
	const ids = new Set<string>();
	for (const question of request.questions) {
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(question.id) || ids.has(question.id) || !question.question.trim()) {
			throw new Error("Questions need unique stable ids and nonempty text.");
		}
		ids.add(question.id);
		if (question.choices) {
			const choices = new Set<string>();
			if (!question.choices.length || question.choices.length > 10) throw new Error("Provide one to ten choices.");
			for (const choice of question.choices) {
				if (!/^[A-Za-z0-9_-]{1,80}$/.test(choice.id) || choices.has(choice.id) || !choice.label.trim()) {
					throw new Error("Choices need unique stable ids and nonempty labels.");
				}
				choices.add(choice.id);
			}
		}
	}
}

export async function askQuestions(request: Request, ctx: Pick<ExtensionContext, "hasUI" | "ui">, signal?: AbortSignal): Promise<QuestionReport> {
	validate(request);
	const answers: QuestionReport["answers"] = [];
	const report = (status: QuestionReport["status"], message: string): QuestionReport => ({
		status, answers, pending: request.questions.slice(answers.length), message,
	});
	if (signal?.aborted) return report("cancelled", "Tool cancelled; no answer was assumed.");
	if (!ctx.hasUI || typeof ctx.ui?.input !== "function" || typeof ctx.ui?.select !== "function") {
		return report("unavailable", "Dialog UI unavailable. Ask the pending questions in chat and wait for actual answers before proceeding with the decision.");
	}
	for (const question of request.questions) {
		if (signal?.aborted) return report("cancelled", "Tool cancelled; retain the partial answers and ask pending questions later.");
		const title = `[${question.id}] ${question.question}${question.description ? `\n${question.description}` : ""}`;
		const options = { signal, timeout: 120_000 };
		try {
			let value: string | undefined;
			let choiceId: string | undefined;
			if (question.choices) {
				const labels = question.choices.map((choice) => `[${choice.id}] ${choice.label}${choice.description ? ` — ${choice.description}` : ""}`);
				let custom = "[custom-answer] Enter another answer";
				while (labels.includes(custom)) custom += " (free text)";
				const selected = await ctx.ui.select(title, question.allowFreeText ? [...labels, custom] : labels, options);
				if (signal?.aborted) return report("cancelled", "Tool cancelled; no answer was assumed for the open dialog.");
				const index = selected === undefined ? -1 : labels.indexOf(selected);
				if (index >= 0) {
					value = question.choices[index]!.label;
					choiceId = question.choices[index]!.id;
				} else if (selected === custom && question.allowFreeText) {
					value = await ctx.ui.input(title, "Your answer", options);
				}
			} else {
				value = await ctx.ui.input(title, "Your answer", options);
			}
			if (signal?.aborted) return report("cancelled", "Tool cancelled; no answer was assumed for the open dialog.");
			if (value === undefined) return report("dismissed", "Dialog dismissed or timed out. No answer was assumed; ask the pending questions in chat and wait.");
			answers.push({ id: question.id, value, ...(choiceId ? { choiceId } : {}) });
		} catch (error) {
			return report(signal?.aborted ? "cancelled" : "unavailable", `Dialog did not complete: ${String(error)}. Ask pending questions in chat and wait; do not invent answers.`);
		}
	}
	return report("answered", "Only submitted answers are recorded.");
}

export function registerQuestion(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "impeccable_question", label: "Impeccable Questions",
		description: "Ask 1–5 related design questions via Pi TUI/RPC dialogs. Returns actual partial answers and answered/dismissed/cancelled/unavailable status. No defaults.",
		parameters: QuestionSchema,
		outputSchema: QuestionResultSchema,
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			const report = await askQuestions(params, ctx, signal);
			return { content: [{ type: "text", text: JSON.stringify(report) }], details: report, structuredContent: report };
		},
	});
}
