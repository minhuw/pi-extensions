import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Outlet } from "react-router";
import { ApiContext, ApiError, useApi } from "../lib/api";
import { useTheme } from "../lib/theme";
import { Icon, PikaLogo } from "./icons";
import { ScrollRootContext } from "./Layout";

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
	return (
		<ApiContext.Provider value={api}>
			<QueryClientProvider client={queryClient}>
				<div className="flex h-full flex-col bg-page text-ink">
					<header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-6">
						<Link to="/public" className="flex items-center gap-1.5 font-semibold"><PikaLogo size={22} />pika</Link>
						<span className="text-[13px] text-muted">Public trajectories</span>
						<button type="button" onClick={toggle} className="ml-auto rounded-sm p-1 text-muted hover:bg-hover" aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
							<Icon name={theme === "dark" ? "sun" : "moon"} />
						</button>
					</header>
					<main ref={setScrollRoot} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto" data-scroll-root="">
						<ScrollRootContext.Provider value={scrollRoot}><Outlet /></ScrollRootContext.Provider>
					</main>
				</div>
			</QueryClientProvider>
		</ApiContext.Provider>
	);
}
