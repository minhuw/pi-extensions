import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router";
import { AuthGate } from "./components/AuthGate";
import { Layout } from "./components/Layout";
import { PublicLayout } from "./components/PublicLayout";
import { Skeleton, SkeletonLines } from "./components/ui";
import { ApiContext, ApiError, PikaApi } from "./lib/api";
import { ActiveSessionsPage } from "./pages/ActiveSessions";
import { DevicesPage } from "./pages/Devices";
import { NotFoundPage } from "./pages/NotFound";
import { HerderRunPage, HerderRunsPage } from "./pages/HerderRuns";
import { LoginPage } from "./pages/Login";
import { SearchPage } from "./pages/Search";
import { SessionListPage } from "./pages/SessionList";
import { SettingsPage } from "./pages/Settings";

// The session page, with its trajectory, transcript renderers, and context viewer, loads on demand in its own chunk.
const SessionViewPage = lazy(() => import("./pages/SessionView").then((module) => ({ default: module.SessionViewPage })));

function SessionPageLoading() {
	return (
		<div className="w-full px-6 pt-6" aria-busy="true" aria-label="Loading session">
			<Skeleton className="h-4 w-40" />
			<Skeleton className="mt-4 h-7 w-2/3" />
			<Skeleton className="mt-3 h-5 w-1/2" />
			<Skeleton className="mt-4 h-[58px] w-full" />
			<div className="mt-8">
				<SkeletonLines lines={4} />
			</div>
		</div>
	);
}

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
			<Route path="public" element={<PublicLayout />}>
				<Route index element={<SessionListPage />} />
				<Route path="s/:id" element={<Suspense fallback={<SessionPageLoading />}><SessionViewPage /></Suspense>} />
				<Route path="*" element={<NotFoundPage />} />
			</Route>
			<Route element={<AuthGate />}>
				<Route element={<Layout />}>
					<Route index element={<SessionListPage />} />
					<Route
						path="s/:id"
						element={
							<Suspense fallback={<SessionPageLoading />}>
								<SessionViewPage />
							</Suspense>
						}
					/>
					<Route path="runs" element={<HerderRunsPage />} />
					<Route path="runs/:id" element={<HerderRunPage />} />
					<Route path="herder" element={<Navigate to="/runs" replace />} />
					<Route path="herder/:id" element={<LegacyRunRedirect />} />
					<Route path="active" element={<ActiveSessionsPage />} />
					<Route path="devices" element={<DevicesPage />} />
					<Route path="settings" element={<SettingsPage />} />
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
