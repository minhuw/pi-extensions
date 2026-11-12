import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "../components/ui";

/**
 * A vertical divider between two panes that resizes the pane on one side: drag it, or focus it and use the arrow
 * keys (Shift for bigger steps). `side` says which pane it sizes, so dragging towards that pane shrinks it.
 */
export function Splitter({
	label,
	value,
	min,
	max,
	side,
	onChange,
	onCommit,
	name,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	/** `left`: the pane left of the divider grows as it moves right. */
	side: "left" | "right";
	onChange: (value: number) => void;
	/** After a drag or a key: the value to keep. */
	onCommit: (value: number) => void;
	name: string;
}) {
	const drag = useRef<{ x: number; start: number; last: number } | null>(null);
	const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)));

	const down = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { x: event.clientX, start: value, last: value };
	};
	const move = (event: PointerEvent<HTMLDivElement>) => {
		const state = drag.current;
		if (!state) return;
		const delta = event.clientX - state.x;
		state.last = clamp(state.start + (side === "left" ? delta : -delta));
		onChange(state.last);
	};
	const up = () => {
		const state = drag.current;
		drag.current = null;
		if (state) onCommit(state.last);
	};
	const key = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? 64 : 16;
		const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
		const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
		let next: number | undefined;
		if (event.key === grow) next = value + step;
		else if (event.key === shrink) next = value - step;
		else if (event.key === "Home") next = min;
		else if (event.key === "End") next = max;
		if (next === undefined) return;
		event.preventDefault();
		onCommit(clamp(next));
	};

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={value}
			aria-valuemin={min}
			aria-valuemax={max}
			tabIndex={0}
			onPointerDown={down}
			onPointerMove={move}
			onPointerUp={up}
			onPointerCancel={up}
			onKeyDown={key}
			className={cx(
				// A 1px rule with a wider hit area over it.
				"relative z-10 -mx-[3px] w-[7px] shrink-0 cursor-col-resize touch-none outline-none",
				"before:absolute before:inset-y-0 before:left-[3px] before:w-px before:bg-line hover:before:bg-dk-line-strong focus-visible:before:w-[2px] focus-visible:before:bg-dk-accent",
			)}
			data-splitter={name}
		/>
	);
}
