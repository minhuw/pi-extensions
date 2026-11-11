export interface GridSize {
	cols: number;
	rows: number;
}

export type ResizeNotice = GridSize & { claim?: true };

/** A claim waits this long for its `term.resized` before typing may claim again. */
export const CLAIM_RETRY_MS = 1_000;

const same = (a: GridSize | undefined, b: GridSize | undefined): boolean =>
	a !== undefined && b !== undefined && a.cols === b.cols && a.rows === b.rows;

/**
 * One terminal's size owner on this channel (NODE.md, "Resize, one size owner"). The terminal always renders at
 * `size`, the PTY's size as the daemon last broadcast it, never at what fits here. Keyboard input while not the owner,
 * and "Fit here", claim with this viewport's fitting size; a passive viewport change only proposes it, which the
 * daemon applies from the owner, or when there is none.
 */
export class SizeOwner {
	#size: GridSize;
	#fit: GridSize | undefined;
	#owned = false;
	#claimedAt = -Infinity;
	readonly #send: (notice: ResizeNotice) => void;
	readonly #now: () => number;

	constructor(initial: GridSize, send: (notice: ResizeNotice) => void, now: () => number = Date.now) {
		this.#size = { cols: initial.cols, rows: initial.rows };
		this.#send = send;
		this.#now = now;
	}

	/** The size to render at: the PTY's. */
	get size(): GridSize {
		return this.#size;
	}

	get owned(): boolean {
		return this.#owned;
	}

	/** Whether this viewport would fit another size than the PTY's, while another client owns the size: offer "Fit here". */
	get canFitHere(): boolean {
		return !this.#owned && this.#fit !== undefined && !same(this.#fit, this.#size);
	}

	/** The viewport's fitting size changed (a passive change: never a claim). */
	fitChanged(fit: GridSize): void {
		if (same(fit, this.#fit)) return;
		this.#fit = { cols: fit.cols, rows: fit.rows };
		if (!same(fit, this.#size)) this.#send({ cols: fit.cols, rows: fit.rows });
	}

	/** Keyboard input is about to go out: claim first when not the owner. */
	input(): void {
		if (this.#owned || this.#now() - this.#claimedAt < CLAIM_RETRY_MS) return;
		this.#claim();
	}

	/** The explicit "Fit here". */
	fitHere(): void {
		this.#claim();
	}

	/** `term.resized` from the daemon. */
	resized(event: GridSize & { owned: boolean }): void {
		this.#size = { cols: event.cols, rows: event.rows };
		this.#owned = event.owned;
		this.#claimedAt = -Infinity;
	}

	/** A fresh attach (also on a new channel): the PTY's size from its reply, and no ownership until told; the view reports its fit again. */
	attached(size: GridSize): void {
		this.#size = { cols: size.cols, rows: size.rows };
		this.#fit = undefined;
		this.#owned = false;
		this.#claimedAt = -Infinity;
	}

	#claim(): void {
		const target = this.#fit ?? this.#size;
		this.#claimedAt = this.#now();
		this.#send({ cols: target.cols, rows: target.rows, claim: true });
	}
}
