import type { Snapshot } from "./contract";

/** What the terminal view does with the stream: reset the screen, write VT data, or attach again. */
export type ScreenOp = { op: "reset"; cols: number; rows: number } | { op: "write"; data: string } | { op: "reattach" };

/**
 * One attached terminal's output stream (NODE.md, "Attach"). Output that arrives before the snapshot is buffered; the
 * snapshot resets the screen, and the buffer plays from `outputSequence + 1`. Output at or below the applied sequence
 * is dropped; a gap asks for a fresh attach, which buffers again until its snapshot. `term.snapshot` (backpressure)
 * replaces the screen the same way.
 */
export class AttachStream {
	#attaching = true;
	#buffer: { seq: number; data: string }[] = [];
	#applied = 0;

	/** Waiting for an attach reply's snapshot. */
	get attaching(): boolean {
		return this.#attaching;
	}

	/** The `seq` of the last chunk on screen. */
	get applied(): number {
		return this.#applied;
	}

	/** A new `term.attach` went out: buffer until its snapshot. */
	begin(): void {
		this.#attaching = true;
		this.#buffer = [];
	}

	output(seq: number, data: string): ScreenOp[] {
		if (this.#attaching) {
			this.#buffer.push({ seq, data });
			return [];
		}
		if (seq <= this.#applied) return [];
		if (seq !== this.#applied + 1) return this.#gap();
		this.#applied = seq;
		return [{ op: "write", data }];
	}

	/** An attach reply's snapshot, or a `term.snapshot` event. */
	snapshot(snapshot: Snapshot): ScreenOp[] {
		const ops: ScreenOp[] = [
			{ op: "reset", cols: snapshot.cols, rows: snapshot.rows },
			{ op: "write", data: snapshot.data },
		];
		this.#applied = snapshot.outputSequence;
		const buffered = this.#buffer;
		this.#buffer = [];
		this.#attaching = false;
		for (const chunk of buffered) {
			const next = this.output(chunk.seq, chunk.data);
			if (next.some((item) => item.op === "reattach")) return [...ops, ...next];
			ops.push(...next);
		}
		return ops;
	}

	#gap(): ScreenOp[] {
		this.begin();
		return [{ op: "reattach" }];
	}
}
