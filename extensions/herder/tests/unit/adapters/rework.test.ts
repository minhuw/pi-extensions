import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prepareReworkFinish, reworkBindingAfterReply, type ReworkEditBinding } from "../../../adapters/rework.ts";

const binding: ReworkEditBinding = {
	planDirectory: "/repo/herder-plans",
	planId: "001",
	editToken: "edit-token",
};

function context(confirm: boolean, events: string[] = [], bodies: string[] = []): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			confirm: async (_title: string, body: string) => {
				events.push("ui");
				bodies.push(body);
				return confirm;
			},
		},
	} as unknown as ExtensionContext;
}

test("rework finish rejects a wrong directory or token before settlement", async () => {
	for (const request of [
		{ planDirectory: binding.planDirectory, editToken: "wrong" },
		{ planDirectory: "/repo/other-plans", editToken: binding.editToken },
	]) {
		const events: string[] = [];
		await assert.rejects(
			() => prepareReworkFinish(binding, request, context(true), {
				edit: async (operation) => { events.push(operation); },
				settle: async () => { events.push("settle"); },
			}),
			/not bound to this exact plan directory and edit token/,
		);
		assert.deepEqual(events, []);
	}
});

test("rework prepare failure leaves workers unsettled", async () => {
	const events: string[] = [];
	await assert.rejects(
		() => prepareReworkFinish(binding, binding, context(true, events), {
			edit: async (operation) => {
				events.push(operation);
				throw new Error("invalid rewritten graph");
			},
			settle: async () => { events.push("settle"); },
		}),
		/invalid rewritten graph/,
	);
	assert.deepEqual(events, ["prepare_edit", "cancel_edit"]);
});

test("rework finish fails closed when no confirmation UI exists", async () => {
	const events: string[] = [];
	await assert.rejects(
		() => prepareReworkFinish(binding, binding, { hasUI: false } as ExtensionContext, {
			edit: async (operation) => { events.push(operation); },
			settle: async () => { events.push("settle"); },
		}),
		/requires an interactive destructive confirmation/,
	);
	assert.deepEqual(events, []);
});

test("declined rework confirmation invokes cancel and processes its reply", async () => {
	const events: string[] = [];
	const bodies: string[] = [];
	let activeBinding: ReworkEditBinding | undefined = binding;
	await assert.rejects(
		() => prepareReworkFinish(binding, binding, context(false, events, bodies), {
			edit: async (operation) => {
				events.push(operation);
				if (operation === "cancel_edit") activeBinding = reworkBindingAfterReply(activeBinding, operation, {});
			},
			settle: async () => { events.push("settle"); },
		}),
		/pre-interview graph was restored.*existing execution was left untouched/,
	);
	assert.deepEqual(events, ["prepare_edit", "ui", "cancel_edit"]);
	assert.equal(activeBinding, undefined);
	assert.match(bodies[0]!, /target-local worker settlement/);
	assert.match(bodies[0]!, /stop only plan 001's workers/);
	assert.match(bodies[0]!, /exact worktree, branch, and transient refs/);
	assert.match(bodies[0]!, /superseded history/);
	assert.match(bodies[0]!, /current integration HEAD at round 1/);
});

test("approved rework orders prepare, UI, confirm, settlement, then outer finish", async () => {
	const events: string[] = [];
	await prepareReworkFinish(binding, binding, context(true, events), {
		edit: async (operation) => { events.push(operation); },
		settle: async () => { events.push("settle"); },
	});
	events.push("finish_edit");
	assert.deepEqual(events, ["prepare_edit", "ui", "confirm_edit", "settle", "finish_edit"]);
});

test("cancel replies clear stale plan-edit and exact rework state", () => {
	const cancelled: { planEdit?: { planId: string } } = {};
	let currentPlanEdit: { planId: string } | undefined = { planId: "001" };
	currentPlanEdit = cancelled.planEdit;
	assert.equal(currentPlanEdit, undefined);
	assert.equal(reworkBindingAfterReply(binding, "cancel_edit", cancelled), undefined);
	assert.equal(reworkBindingAfterReply(binding, "finish_edit", {}), undefined);
	assert.equal(reworkBindingAfterReply(binding, "cancel_edit", { planEdit: { planId: "001" } }), binding);
});
