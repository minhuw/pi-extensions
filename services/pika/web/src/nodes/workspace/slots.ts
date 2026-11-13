import type { TerminalCommand, TerminalHandle, TerminalSlots } from "../panes/slot-contract";
import type { Renderer } from "../renderer";
import { settle } from "../resize-gate";

const slotKey = (node: string, terminalId: string): string => `${node}\n${terminalId}`;

/**
 * Where each terminal is drawn: the slot element a pane view registered for it (`TerminalSlots.attach`), per node.
 * The terminal layer follows these. A pane that moves registers its new slot before or after the old one lets go,
 * as React orders it, so a release takes effect only if the slot it held has left the page by then.
 *
 * It also carries what passes between the drawn terminals and the chrome around them: each terminal's commands
 * (`TerminalSlots.command`, for the tab strip and the tab menu), and the renderer each shown terminal draws with, for
 * the status bar.
 */
export class SlotRegistry {
	#slots = new Map<string, HTMLElement>();
	#listeners = new Map<string, Set<() => void>>();
	#layout = new Set<() => void>();
	#views = new Map<string, TerminalSlots>();
	#handles = new Map<string, TerminalHandle>();
	#renderers = new Map<string, Renderer>();
	#rendererListeners = new Set<() => void>();
	#fallback: Renderer | undefined;

	get(node: string, terminalId: string): HTMLElement | undefined {
		return this.#slots.get(slotKey(node, terminalId));
	}

	attach(node: string, terminalId: string, element: HTMLElement | null): void {
		const key = slotKey(node, terminalId);
		if (element) {
			if (this.#slots.get(key) === element) return;
			this.#slots.set(key, element);
			this.#notify(key);
			return;
		}
		const held = this.#slots.get(key);
		if (!held) return;
		queueMicrotask(() => {
			if (this.#slots.get(key) !== held || held.isConnected) return;
			this.#slots.delete(key);
			this.#notify(key);
		});
	}

	/** `listener` hears `terminalId`'s slot change. */
	subscribe(node: string, terminalId: string, listener: () => void): () => void {
		const key = slotKey(node, terminalId);
		let set = this.#listeners.get(key);
		if (!set) this.#listeners.set(key, (set = new Set()));
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.#listeners.delete(key);
		};
	}

	/** Slots may have moved without changing size (the workspace's layout changed): every terminal measures again. */
	layoutChanged(): void {
		for (const listener of [...this.#layout]) listener();
	}

	onLayout(listener: () => void): () => void {
		this.#layout.add(listener);
		return () => this.#layout.delete(listener);
	}

	/** `terminalId`'s drawn terminal registers its commands while it is mounted. */
	setHandle(node: string, terminalId: string, handle: TerminalHandle): void {
		this.#handles.set(slotKey(node, terminalId), handle);
	}

	/** A drawn terminal unmounted: its commands go, unless a newer drawing of it registered since. */
	dropHandle(node: string, terminalId: string, handle: TerminalHandle): void {
		const key = slotKey(node, terminalId);
		if (this.#handles.get(key) === handle) this.#handles.delete(key);
	}

	command(node: string, terminalId: string, command: TerminalCommand): boolean {
		const handle = this.#handles.get(slotKey(node, terminalId));
		if (!handle) return false;
		handle[command]();
		return true;
	}

	offersFit(node: string, terminalId: string): boolean {
		return this.#handles.get(slotKey(node, terminalId))?.offersFit() ?? false;
	}

	/** The renderer a shown terminal draws with; undefined while it is hidden or gone. */
	setRenderer(node: string, terminalId: string, renderer: Renderer | undefined): void {
		const key = slotKey(node, terminalId);
		if (renderer === undefined) this.#renderers.delete(key);
		else this.#renderers.set(key, renderer);
		const states = new Set(this.#renderers.values());
		// A page without WebGL first, as it explains every terminal; then a failed start; then a lost context.
		const next = (["no-webgl", "webgl-failed", "context-lost"] as const).find((state) => states.has(state));
		if (next === this.#fallback) return;
		this.#fallback = next;
		for (const listener of [...this.#rendererListeners]) listener();
	}

	/** Why a shown terminal draws with the DOM renderer, if one does (for `useSyncExternalStore`). */
	fallback = (): Renderer | undefined => this.#fallback;

	subscribeRenderers = (listener: () => void): (() => void) => {
		this.#rendererListeners.add(listener);
		return () => this.#rendererListeners.delete(listener);
	};

	/** The `TerminalSlots` a node's pane views register with. */
	forNode(node: string): TerminalSlots {
		let view = this.#views.get(node);
		if (!view) {
			view = {
				attach: (terminalId, element) => this.attach(node, terminalId, element),
				resizeEnd: () => {
					this.layoutChanged();
					settle();
				},
				command: (terminalId, command) => this.command(node, terminalId, command),
				offersFit: (terminalId) => this.offersFit(node, terminalId),
			};
			this.#views.set(node, view);
		}
		return view;
	}

	#notify(key: string): void {
		for (const listener of [...(this.#listeners.get(key) ?? [])]) listener();
	}
}
