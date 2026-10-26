import { useEffect, useState } from "react";

/** How long buttons stay disabled after a polled list changes, so a click aimed before the items moved can't land on another. */
export const LAYOUT_GUARD_MS = 1_000;

/** The current time, ticking every `intervalMs` while `active`. */
export function useNow(active: boolean, intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [active, intervalMs]);
	return now;
}

/** True for `ms` after `key` changes; not when it first gets a value. */
export function useSettling(key: string | undefined, ms: number): boolean {
	const [last, setLast] = useState(key);
	const [changes, setChanges] = useState(0);
	const [settled, setSettled] = useState(0);
	// Set during render, so the render that shows the change already disables the buttons.
	if (key !== last) {
		setLast(key);
		if (last !== undefined && key !== undefined) setChanges(changes + 1);
	}
	useEffect(() => {
		if (changes === 0) return;
		const timer = setTimeout(() => setSettled(changes), ms);
		return () => clearTimeout(timer);
	}, [changes, ms]);
	return changes !== settled;
}
