/**
 * A terminal's WebGL renderer, held only while the terminal shows. Browsers allow about 16 WebGL contexts per page,
 * so a hidden terminal gives its context back and draws with xterm's DOM renderer until it shows again (Orca does
 * the same before it moves or hides a terminal).
 */

/** `webgl`, or why the DOM renderer draws instead (xterm 6 has no canvas renderer). `hidden`: released while hidden. */
export type Renderer = "webgl" | "hidden" | "no-webgl" | "webgl-failed" | "context-lost";

export interface WebglLike {
	onContextLoss(listener: () => void): { dispose(): void } | void;
	dispose(): void;
}

export interface RendererHost<A extends WebglLike> {
	loadAddon(addon: A): void;
}

export class WebglRenderer<A extends WebglLike = WebglLike> {
	#host: RendererHost<A>;
	#make: () => A;
	#addon: A | undefined;
	#state: Renderer;
	#onState: (state: Renderer) => void;

	/** `available`: the page can make a WebGL2 context at all. Starts hidden: `show` loads the addon. */
	constructor(host: RendererHost<A>, make: () => A, onState: (state: Renderer) => void, available: boolean) {
		this.#host = host;
		this.#make = make;
		this.#onState = onState;
		this.#state = available ? "hidden" : "no-webgl";
		onState(this.#state);
	}

	get state(): Renderer {
		return this.#state;
	}

	/** Whether a WebGL context is held now. */
	get loaded(): boolean {
		return this.#addon !== undefined;
	}

	/** The terminal shows: take a context, unless WebGL is unavailable or failed to start. A lost context is tried again. */
	show(): void {
		if (this.#addon || this.#state === "no-webgl" || this.#state === "webgl-failed") return;
		let addon: A;
		try {
			addon = this.#make();
			addon.onContextLoss(() => {
				if (this.#addon !== addon) return;
				this.#release();
				this.#set("context-lost");
			});
			this.#host.loadAddon(addon);
		} catch {
			this.#set("webgl-failed");
			return;
		}
		this.#addon = addon;
		this.#set("webgl");
	}

	/** The terminal is hidden: give the context back. */
	hide(): void {
		if (!this.#addon) return;
		this.#release();
		this.#set("hidden");
	}

	dispose(): void {
		this.#release();
	}

	#release(): void {
		const addon = this.#addon;
		this.#addon = undefined;
		try {
			addon?.dispose();
		} catch {
			// A context already lost can throw on dispose; it is gone either way.
		}
	}

	#set(state: Renderer): void {
		if (this.#state === state) return;
		this.#state = state;
		this.#onState(state);
	}
}
