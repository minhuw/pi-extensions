import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router";
import { AuthGate } from "./components/AuthGate";
import { Layout } from "./components/Layout";
import { ApiContext, ApiError, PikaApi } from "./lib/api";
import { NotFoundPage } from "./pages/NotFound";
import { HerderRunPage, HerderRunsPage } from "./pages/HerderRuns";
import { LoginPage } from "./pages/Login";
import { SearchPage } from "./pages/Search";
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

function LegacyRunRedirect() {
	const { id = "" } = useParams();
	return <Navigate to={`/runs/${encodeURIComponent(id)}`} replace />;
}

export function AppRoutes() {
	return (
		<Routes>
			<Route path="login" element={<LoginPage />} />
			<Route element={<AuthGate />}>
				<Route element={<Layout />}>
					<Route index element={<SessionListPage />} />
					<Route path="s/:id" element={<SessionViewPage />} />
					<Route path="runs" element={<HerderRunsPage />} />
					<Route path="runs/:id" element={<HerderRunPage />} />
					<Route path="herder" element={<Navigate to="/runs" replace />} />
					<Route path="herder/:id" element={<LegacyRunRedirect />} />
					<Route path="search" element={<SearchPage />} />
					<Route path="*" element={<NotFoundPage />} />
				</Route>
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
