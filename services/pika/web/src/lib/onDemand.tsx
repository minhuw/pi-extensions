import { lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";

/** A component loaded on demand, and the call that starts loading it early (on idle, or on an intent such as a hover). */
export type OnDemand<P extends object> = ComponentType<P> & { preload: () => Promise<unknown> };

/**
 * A component whose code loads the first time it renders (or when `preload` is called), in its own chunk. Until it
 * has loaded it draws `fallback`, which should take the space the component will, so nothing shifts. Once loaded it
 * renders at once, without suspending: an instance mounted after the load draws the component directly, and one
 * mounted before keeps its `React.lazy` boundary, so no instance is mounted twice.
 */
export function onDemand<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode = null): OnDemand<P> {
	let loaded: ComponentType<P> | undefined;
	let loading: Promise<ComponentType<P>> | undefined;
	const preload = () =>
		(loading ??= load().then(
			(component) => (loaded = component),
			(error: unknown) => {
				// A failed load (a deploy replaced the chunk, the network dropped) is tried again next time.
				loading = undefined;
				throw error;
			},
		));
	const Lazy = lazy(async () => ({ default: await preload() }));
	function OnDemandComponent(props: P) {
		const [Direct] = useState(() => loaded);
		if (Direct) return <Direct {...props} />;
		return (
			<Suspense fallback={fallback}>
				<Lazy {...props} />
			</Suspense>
		);
	}
	return Object.assign(OnDemandComponent, { preload });
}

/** Runs `run` once the browser is idle (or after a short delay where it cannot tell). */
export function whenIdle(run: () => void): () => void {
	if (typeof requestIdleCallback === "function") {
		const id = requestIdleCallback(run, { timeout: 2_000 });
		return () => cancelIdleCallback(id);
	}
	const timer = setTimeout(run, 200);
	return () => clearTimeout(timer);
}
