import { useLayoutEffect, useState, type RefObject } from "react";

/** Distance from the top of the scroll content to `ref`, for a virtualizer's `scrollMargin`. */
export function useScrollMargin(ref: RefObject<HTMLElement | null>, scrollRoot: HTMLElement | null): number {
	const [margin, setMargin] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element || !scrollRoot) return;
		const next = Math.round(element.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top + scrollRoot.scrollTop);
		if (next !== margin) setMargin(next);
	});
	return margin;
}
