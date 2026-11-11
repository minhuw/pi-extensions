import { describe, expect, it } from "vitest";
import { CLAIM_RETRY_MS, SizeOwner, type ResizeNotice } from "../src/nodes/size";

function owner(initial = { cols: 80, rows: 24 }) {
	const sent: ResizeNotice[] = [];
	let now = 1_000;
	const size = new SizeOwner(initial, (notice) => sent.push(notice), () => now);
	return { size, sent, advance: (ms: number) => (now += ms) };
}

describe("one size owner", () => {
	it("proposes a passive fit without claiming", () => {
		const { size, sent } = owner();
		size.fitChanged({ cols: 100, rows: 30 });
		expect(sent).toEqual([{ cols: 100, rows: 30 }]);
		// The same fit again sends nothing; a fit equal to the PTY's sends nothing.
		size.fitChanged({ cols: 100, rows: 30 });
		size.fitChanged({ cols: 80, rows: 24 });
		expect(sent).toHaveLength(1);
	});

	it("claims on keyboard input while not the owner, once until the daemon answers", () => {
		const { size, sent, advance } = owner();
		size.fitChanged({ cols: 100, rows: 30 });
		sent.length = 0;
		size.input();
		size.input();
		expect(sent).toEqual([{ cols: 100, rows: 30, claim: true }]);
		advance(CLAIM_RETRY_MS);
		size.input();
		expect(sent).toHaveLength(2);
		size.resized({ cols: 100, rows: 30, owned: true });
		size.input();
		expect(sent).toHaveLength(2);
		expect(size.owned).toBe(true);
	});

	it("renders a non-owner at exactly the broadcast size, offering Fit here", () => {
		const { size, sent } = owner();
		size.fitChanged({ cols: 100, rows: 30 });
		size.resized({ cols: 120, rows: 40, owned: false });
		expect(size.size).toEqual({ cols: 120, rows: 40 });
		expect(size.canFitHere).toBe(true);
		sent.length = 0;
		size.fitHere();
		expect(sent).toEqual([{ cols: 100, rows: 30, claim: true }]);
	});

	it("does not offer Fit here to the owner, or when the sizes already match", () => {
		const { size } = owner();
		size.fitChanged({ cols: 100, rows: 30 });
		size.resized({ cols: 100, rows: 30, owned: false });
		expect(size.canFitHere).toBe(false);
		size.fitChanged({ cols: 90, rows: 30 });
		size.resized({ cols: 120, rows: 40, owned: true });
		expect(size.canFitHere).toBe(false);
	});

	it("loses ownership when another client claims, and on a fresh attach", () => {
		const { size } = owner();
		size.resized({ cols: 100, rows: 30, owned: true });
		size.resized({ cols: 90, rows: 20, owned: false });
		expect(size.owned).toBe(false);
		size.resized({ cols: 90, rows: 20, owned: true });
		size.attached({ cols: 90, rows: 20 });
		expect(size.owned).toBe(false);
	});

	it("claims at the PTY's size before any fit is known", () => {
		const { size, sent } = owner({ cols: 70, rows: 20 });
		size.input();
		expect(sent).toEqual([{ cols: 70, rows: 20, claim: true }]);
	});
});
