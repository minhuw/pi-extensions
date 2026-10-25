import { useEffect, useRef } from "react";

export function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/** Single-key shortcuts, ignored while typing or with modifier keys held. */
export function useShortcuts(handlers: Record<string, (event: KeyboardEvent) => void>): void {
	const ref = useRef(handlers);
	ref.current = handlers;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
			if (isTypingTarget(event.target)) return;
			const handler = ref.current[event.key];
			if (!handler) return;
			event.preventDefault();
			handler(event);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}
