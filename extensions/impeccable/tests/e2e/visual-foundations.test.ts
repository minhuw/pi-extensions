import { afterAll, beforeAll, expect, it } from "vitest";
import { detectorPhase, project } from "./detector-phase.ts";

import { directionPhase } from "./direction-phase.ts";
import { foundations } from "./foundations.ts";
let foundation: Awaited<ReturnType<typeof foundations>>;
beforeAll(async () => { foundation = await foundations(); });
afterAll(async () => { await foundation?.cleanup(); }, 30_000);
it("acquires isolated Chromium and verifies the pinned native engine", () => {
	expect(foundation.receipt.browser).toBeDefined();
	expect(foundation.receipt.engine).toBeDefined();
});
it("delivers genuine native detector feedback through Pi native edits", async () => {
	await detectorPhase(foundation, await project(foundation));
});
it("serves the native direction board and collects a Chromium DOM choice", async () => {
	await directionPhase(foundation, await project(foundation, "direction-project"));
});
