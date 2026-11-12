/**
 * When a terminal may tell its node a new size (NODE.md, "Resize"): not while a pointer is down (a divider or a
 * sidebar is being dragged; the terminal follows its box on screen meanwhile), but when it comes up, or when a
 * view says a resize ended (`settle`). Each `whenSettled` callback runs once.
 */

let down = 0;
const waiting = new Set<() => void>();
const settledListeners = new Set<() => void>();
let installed = false;

function flush(): void {
	const run = [...waiting];
	waiting.clear();
	for (const fn of run) fn();
	for (const listener of [...settledListeners]) listener();
}

function install(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;
	window.addEventListener("pointerdown", () => void down++, true);
	const up = () => {
		if (down === 0) return;
		down = 0;
		// After the drag's own pointerup handlers have committed its layout, and the browser laid it out.
		requestAnimationFrame(flush);
	};
	window.addEventListener("pointerup", up, true);
	window.addEventListener("pointercancel", up, true);
	window.addEventListener("blur", up);
}

/** Whether a pointer is down now. */
export function pointerHeld(): boolean {
	install();
	return down > 0;
}

/** Runs `fn` now, or once the pointer is up. Returns a function that drops it if it has not run. */
export function whenSettled(fn: () => void): () => void {
	install();
	if (down === 0) {
		fn();
		return () => {};
	}
	waiting.add(fn);
	return () => waiting.delete(fn);
}

/** Every resize settled (a divider drag ended): terminals fit their boxes again. */
export function onSettled(listener: () => void): () => void {
	settledListeners.add(listener);
	return () => settledListeners.delete(listener);
}

/** A view's resize ended (`TerminalSlots.resizeEnd`). */
export function settle(): void {
	down = 0;
	flush();
}
