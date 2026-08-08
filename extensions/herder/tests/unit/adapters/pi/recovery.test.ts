import assert from "node:assert/strict";
import test from "node:test";
import { interruptedPiWorkers } from "../../../../adapters/pi/recovery.ts";

test("recovery interrupts only missing built-in workers", () => {
	assert.deepEqual(interruptedPiWorkers([
		{ actionId: "active", hostHandle: "pi-worker:active" },
		{ actionId: "lost", hostHandle: "pi-worker:lost" },
		{ actionId: "proposed" },
	], (handle) => handle === "pi-worker:active"), [{
		actionId: "lost",
		hostHandle: "pi-worker:lost",
		interrupted: true,
		error: "Pi host restarted before its in-process worker completed",
	}]);
});

test("recovery fails closed for a worker owned by another engine", () => {
	assert.throws(
		() => interruptedPiWorkers([{ actionId: "legacy", hostHandle: "legacy-run-1" }], () => false),
		/incompatible Pi worker engine/,
	);
});
