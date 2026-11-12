import type { TerminalSlots } from "../panes/slot-contract";
import { settle } from "../resize-gate";

const slotKey = (node: string, terminalId: string): string => `${node}\n${terminalId}`;

/**
 * Where each terminal is drawn: the slot element a pane view registered for it (`TerminalSlots.attach`), per node.
 * The terminal layer follows these. A pane that moves registers its new slot before or after the old one lets go,
 * as React orders it, so a release takes effect only if the slot it held has left the page by then.
 */
export class SlotRegistry {
	#slots = new Map<string, HTMLElement>();
	#listeners = new Map<string, Set<() => void>>();
	#layout = new Set<() => void>();
	#views = new Map<string, TerminalSlots>();

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
			};
			this.#views.set(node, view);
		}
		return view;
	}

	#notify(key: string): void {
		for (const listener of [...(this.#listeners.get(key) ?? [])]) listener();
	}
}
