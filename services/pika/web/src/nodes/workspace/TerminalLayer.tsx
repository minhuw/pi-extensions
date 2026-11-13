/**
 * The terminal layer: every terminal any workspace shows is drawn here once, keyed by its node and id, and placed
 * over the slot its pane registered (`SlotRegistry`). Moving a tab between groups, splitting, switching tabs or
 * places only moves (or hides) the drawn terminal; its xterm is never built again. A terminal without a slot on
 * screen is hidden, which gives back its WebGL context (`TerminalView`'s `visible`).
 *
 * The idea is Orca's `TerminalPaneOverlayLayer` (`src/renderer/src/components/terminal-pane/mounting/`, MIT, Copyright
 * (c) 2026 Lovecast Inc.; see ORCA-LICENSE); the code is pika's own, and places terminals with measured boxes rather
 * than CSS anchor positioning.
 */

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Theme } from "../../lib/theme";
import type { NodeChannel } from "../channel";
import type { TerminalInfo } from "../contract";
import { keepsPaneOnExit } from "../panes/actions";
import { TerminalView } from "../TerminalView";
import { SetupFooter, type SetupAction } from "./SetupFooter";
import type { SlotRegistry } from "./slots";

export interface LayerTerminal {
	node: string;
	/** The node's channel number: a new channel draws its terminals afresh, as they attach again. */
	epoch: number;
	channel: NodeChannel;
	terminal: TerminalInfo;
	home: string;
}

export interface TerminalLayerProps {
	registry: SlotRegistry;
	terminals: readonly LayerTerminal[];
	theme: Theme;
	onFocus: (node: string, terminalId: string) => void;
	onKill: (node: string, terminal: TerminalInfo) => void;
	onOpenFile: (node: string, terminalId: string, path: string, at?: { line: number; column?: number }) => void;
	/** The terminal shows while the page is visible and it has unread output: `pane.seen`. */
	onSeen: (node: string, terminalId: string) => void;
	/** The footer of an exited setup terminal (`SetupFooter`) chose an action for its pane. */
	onSetupAction: (node: string, terminalId: string, action: SetupAction) => Promise<void>;
}

/** The `data-layer-terminal` value of a terminal's box, for finding it. */
export const layerKey = (node: string, terminalId: string): string => `${node}\n${terminalId}`;

export function TerminalLayer(props: TerminalLayerProps) {
	return (
		// Under the workspace's drop previews (z-20); the boxes cover only the slots, never the dividers or tab strips.
		<div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" data-terminal-layer="">
			{props.terminals.map((entry) => (
				<LayerItem key={`${entry.node}\n${entry.epoch}\n${entry.terminal.terminalId}`} {...props} entry={entry} />
			))}
		</div>
	);
}

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

const sameBox = (a: Box, b: Box) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

const LayerItem = memo(function LayerItem({
	entry,
	registry,
	theme,
	onFocus,
	onKill,
	onOpenFile,
	onSeen,
	onSetupAction,
}: TerminalLayerProps & { entry: LayerTerminal }) {
	const { node, terminal } = entry;
	const id = terminal.terminalId;
	const [box, setBox] = useState<Box | null>(null);
	const self = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		let observed: HTMLElement | undefined;
		const observer = new ResizeObserver(() => measure());
		const measure = () => {
			const slot = registry.get(node, id);
			if (slot !== observed) {
				if (observed) observer.unobserve(observed);
				if (slot) observer.observe(slot);
				observed = slot;
			}
			// The layer: this box's parent, attached before this effect runs (the layer's own ref is not, yet).
			const container = self.current?.parentElement;
			if (!slot || !slot.isConnected || !container) return setBox(null);
			const r = slot.getBoundingClientRect();
			const c = container.getBoundingClientRect();
			const next = { left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height };
			setBox((current) => (current && sameBox(current, next) ? current : next));
		};
		measure();
		const container = self.current?.parentElement;
		if (container) observer.observe(container);
		const offSlot = registry.subscribe(node, id, measure);
		const offLayout = registry.onLayout(measure);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			offSlot();
			offLayout();
			window.removeEventListener("resize", measure);
		};
	}, [registry, node, id]);

	const visible = box !== null && box.width >= 1 && box.height >= 1;
	const unread = terminal.status?.unread === true;

	useEffect(() => {
		if (!visible || !unread) return;
		const mark = () => {
			if (document.visibilityState === "visible") onSeen(node, id);
		};
		mark();
		document.addEventListener("visibilitychange", mark);
		return () => document.removeEventListener("visibilitychange", mark);
	}, [visible, unread, node, id, onSeen]);

	return (
		<div
			ref={self}
			className="pointer-events-auto absolute flex flex-col bg-page"
			style={visible ? { left: box.left, top: box.top, width: box.width, height: box.height } : { display: "none" }}
			data-layer-terminal={layerKey(node, id)}
			data-visible={visible ? "" : undefined}
		>
			<TerminalView
				channel={entry.channel}
				terminal={terminal}
				theme={theme}
				home={entry.home}
				visible={visible}
				onFocus={() => onFocus(node, id)}
				onKill={() => onKill(node, terminal)}
				onOpenFile={(path, at) => onOpenFile(node, id, path, at)}
			/>
			{terminal.exited && keepsPaneOnExit(terminal) && <SetupFooter exited={terminal.exited} onAction={(action) => onSetupAction(node, id, action)} />}
		</div>
	);
});
