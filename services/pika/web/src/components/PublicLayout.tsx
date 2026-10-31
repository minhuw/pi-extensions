import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { ApiContext, ApiError, useApi } from "../lib/api";
import { inGuestView, setGuestView } from "../lib/guestView";
import { useTheme } from "../lib/theme";
import { Icon } from "./icons";
import { BAND_CONTROL, ScrollRootContext, SignBand, ThemeToggle } from "./Layout";

/** Anonymous pages have their own client and cache, even when the browser is also signed in. */
export function PublicLayout() {
	const ownerApi = useApi();
	const [api] = useState(() => ownerApi.forPublic());
	const [queryClient] = useState(() => new QueryClient({
		defaultOptions: { queries: {
			staleTime: 0,
			gcTime: 0,
			refetchOnWindowFocus: true,
			retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.status < 500),
		} },
	}));
	const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
	const { theme, toggle } = useTheme();
	// Signing in opens the owner's view of this page; a browser that is already signed in goes straight there, which is
	// also the way out of the owner's guest view.
	const location = useLocation();
	const ownerPage = (location.pathname.replace(/^\/public(?=\/|$)/, "") || "/") + location.search;
	const [guestView] = useState(inGuestView);
	return (
		<ApiContext.Provider value={api}>
			<QueryClientProvider client={queryClient}>
				<div className="flex h-full flex-col bg-page text-ink">
					<SignBand
						home="/public"
						controls={
							<>
								<ThemeToggle theme={theme} onToggle={toggle} />
								<Link to={`/login?next=${encodeURIComponent(ownerPage)}`} onClick={() => setGuestView(false)} className={BAND_CONTROL}>
									{guestView ? (
										<>
											<Icon name="eye" />
											Exit guest view
										</>
									) : (
										"Sign in"
									)}
								</Link>
							</>
						}
					>
						<span className="text-[13.5px] font-medium whitespace-nowrap text-band-muted">Public trajectories</span>
					</SignBand>
					<main ref={setScrollRoot} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto" data-scroll-root="">
						<ScrollRootContext.Provider value={scrollRoot}><Outlet /></ScrollRootContext.Provider>
					</main>
				</div>
			</QueryClientProvider>
		</ApiContext.Provider>
	);
}
