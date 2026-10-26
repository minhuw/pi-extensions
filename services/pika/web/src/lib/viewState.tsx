import { createContext, useCallback, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

const ViewStateContext = createContext<Map<string, unknown> | null>(null);

/** Holds view state for components that virtual lists unmount and remount while scrolling. */
export function ViewStateProvider({ children }: { children: ReactNode }) {
	const [store] = useState(() => new Map<string, unknown>());
	return <ViewStateContext.Provider value={store}>{children}</ViewStateContext.Provider>;
}

/** `useState` that remembers its value under `key` for the nearest `ViewStateProvider`. */
export function useViewState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
	const store = useContext(ViewStateContext);
	const [value, setValue] = useState<T>(() => {
		if (store?.has(key)) return store.get(key) as T;
		return typeof initial === "function" ? (initial as () => T)() : initial;
	});
	const set = useCallback<Dispatch<SetStateAction<T>>>(
		(action) =>
			setValue((previous) => {
				const next = typeof action === "function" ? (action as (value: T) => T)(previous) : action;
				store?.set(key, next);
				return next;
			}),
		[store, key],
	);
	return [value, set];
}
