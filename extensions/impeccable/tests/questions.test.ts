import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { askQuestions } from "../src/questions.ts";

const questions = [
	{ id: "approve", question: "Approve?", choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No", description: "Keep exploring" }], allowFreeText: true },
	{ id: "purpose", question: "What is the purpose?", description: "Describe the visitor's goal" },
];
function context(select = vi.fn(), input = vi.fn(), hasUI = true) {
	return { hasUI, ui: { select, input } } as unknown as Pick<ExtensionContext, "hasUI" | "ui">;
}

describe("structured question outcomes", () => {
	it("preserves No, stable choice ids, descriptions and exact free text without a confirm dialog", async () => {
		const ctx = context(vi.fn().mockResolvedValue("[no] No — Keep exploring"), vi.fn().mockResolvedValue("  actual purpose\nsecond line  "));
		const result = await askQuestions({ questions }, ctx);
		expect(result).toMatchObject({ status: "answered", answers: [{ id: "approve", choiceId: "no", value: "No" }, { id: "purpose", value: "  actual purpose\nsecond line  " }], pending: [] });
		expect(ctx.ui.select).toHaveBeenCalledWith("[approve] Approve?", expect.arrayContaining(["[no] No — Keep exploring"]), expect.objectContaining({ timeout: 120000 }));
		expect(ctx.ui.input).toHaveBeenCalledWith(expect.stringContaining("Describe the visitor's goal"), "Your answer", expect.anything());
	});
	it("allows a custom answer and retains an explicitly submitted empty string", async () => {
		const result = await askQuestions({ questions: [questions[0]!] }, context(vi.fn().mockResolvedValue("[custom-answer] Enter another answer"), vi.fn().mockResolvedValue("")));
		expect(result.answers).toEqual([{ id: "approve", value: "" }]);
		expect(result.status).toBe("answered");
	});
	it("records partial answers and stops at dismissal with no default for later questions", async () => {
		const input = vi.fn().mockResolvedValue(undefined);
		const result = await askQuestions({ questions }, context(vi.fn().mockResolvedValue("[yes] Yes"), input));
		expect(result.status).toBe("dismissed");
		expect(result.answers).toEqual([{ id: "approve", value: "Yes", choiceId: "yes" }]);
		expect(result.pending).toEqual([questions[1]]);
		expect(result.message).toContain("wait");
	});
	it("distinguishes tool cancellation during a dialog and preserves earlier answers", async () => {
		const controller = new AbortController();
		const input = vi.fn(async (_title, _placeholder, opts) => {
			expect(opts.signal).toBe(controller.signal);
			controller.abort();
			return undefined;
		});
		const result = await askQuestions({ questions }, context(vi.fn().mockResolvedValue("[no] No — Keep exploring"), input), controller.signal);
		expect(result.status).toBe("cancelled");
		expect(result.answers).toEqual([{ id: "approve", value: "No", choiceId: "no" }]);
		expect(result.pending).toEqual([questions[1]]);
	});
	it("does not open UI after a pre-aborted request", async () => {
		const ctx = context();
		const result = await askQuestions({ questions }, ctx, AbortSignal.abort());
		expect(result.status).toBe("cancelled");
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});
	it("returns usable chat instructions immediately without UI", async () => {
		const ctx = context(vi.fn(), vi.fn(), false);
		const result = await askQuestions({ questions }, ctx);
		expect(result).toMatchObject({ status: "unavailable", answers: [], pending: questions });
		expect(result.message).toContain("chat and wait");
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});
	it("reports a UI failure without discarding partial answers", async () => {
		const result = await askQuestions({ questions }, context(vi.fn().mockResolvedValue("[yes] Yes"), vi.fn().mockRejectedValue(new Error("UI disconnected"))));
		expect(result.status).toBe("unavailable");
		expect(result.answers).toHaveLength(1);
		expect(result.message).toContain("UI disconnected");
	});
	it.each([
		{ questions: [questions[0], { ...questions[1], id: "approve" }] },
		{ questions: [questions[0], { ...questions[1], id: "bad id" }] },
		{ questions: [questions[0], { ...questions[1], choices: [{ id: "same", label: "A" }, { id: "same", label: "B" }] }] },
		{ questions: [questions[0], { ...questions[1], question: " " }] },
	])("validates the entire batch before opening its first dialog: %j", async (request) => {
		const ctx = context();
		await expect(askQuestions(request as never, ctx)).rejects.toThrow();
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});
});
