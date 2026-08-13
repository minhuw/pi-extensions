import assert from "node:assert/strict";
import test from "node:test";
import { OrcaBusyGate } from "./orca-busy.ts";

test("does not claim Orca while the parent turn is still running", () => {
	const gate = new OrcaBusyGate();
	assert.equal(gate.set("herder", true, false), null);
	assert.equal(gate.held, false);
});

test("claims Orca after the parent settles with work still running", () => {
	const gate = new OrcaBusyGate();
	assert.equal(gate.set("herder", true, false), null);
	assert.equal(gate.onParentSettled(true), "start");
	assert.equal(gate.held, true);
});

test("releases Orca when Herder and subagents are both idle", () => {
	const gate = new OrcaBusyGate();
	assert.equal(gate.set("herder", true, true), "start");
	assert.equal(gate.set("subagents", true, true), null);
	assert.equal(gate.set("herder", false, true), null);
	assert.equal(gate.set("subagents", false, true), "end");
	assert.equal(gate.held, false);
});

test("does not end a synthetic run while the parent is busy", () => {
	const gate = new OrcaBusyGate();
	assert.equal(gate.set("subagents", true, true), "start");
	assert.equal(gate.set("subagents", false, false), null);
	assert.equal(gate.held, true);
	assert.equal(gate.onParentSettled(true), "end");
});
