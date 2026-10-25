import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { ApiContext, ApiError, PikaApi } from "./lib/api";
import { NotFoundPage } from "./pages/NotFound";
import { HerderRunsPage, SearchPage } from "./pages/Placeholders";
import { SessionListPage } from "./pages/SessionList";
import { SessionViewPage } from "./pages/SessionView";

export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false,
				retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.status < 500),
			},
		},
	});
}

export function AppRoutes() {
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route index element={<SessionListPage />} />
				<Route path="s/:id" element={<SessionViewPage />} />
				<Route path="herder" element={<HerderRunsPage />} />
				<Route path="herder/:runId" element={<HerderRunsPage />} />
				<Route path="search" element={<SearchPage />} />
				<Route path="*" element={<NotFoundPage />} />
			</Route>
		</Routes>
	);
}

export function AppProviders({ api, queryClient, children }: { api: PikaApi; queryClient: QueryClient; children: ReactNode }) {
	return (
		<ApiContext.Provider value={api}>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</ApiContext.Provider>
	);
}

export function App({ base }: { base: string }) {
	const [api] = useState(() => new PikaApi(base));
	const [queryClient] = useState(createQueryClient);
	return (
		<AppProviders api={api} queryClient={queryClient}>
			<BrowserRouter basename={base}>
				<AppRoutes />
			</BrowserRouter>
		</AppProviders>
	);
}
