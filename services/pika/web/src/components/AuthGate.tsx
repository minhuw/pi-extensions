import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { matchPath, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { authModeOf, useApi } from "../lib/api";
import type { Me } from "../lib/types";

export const ME_KEY = ["me"] as const;

export function useMe() {
	const api = useApi();
	return useQuery({ queryKey: ME_KEY, queryFn: () => api.me(), staleTime: 60_000, retry: false });
}

/** What `me` reads as once this browser has been signed out. */
export const SIGNED_OUT: Me = { authenticated: false, passwordRequired: true, authMode: "password" };

/** Only password mode signs browsers in; a proxy or no authentication never shows the login page. */
export function needsLogin(me: Me | undefined): boolean {
	return authModeOf(me) === "password" && !me?.authenticated;
}

function loginPath(location: { pathname: string; search: string }): string {
	return `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

/** The anonymous client, for asking what a signed-out visitor may see; it learns nothing the public API doesn't serve. */
function usePublicApi() {
	const api = useApi();
	return useMemo(() => api.forPublic(), [api]);
}

/** Whether any project is published, so the public gallery has something to show. */
export function useGalleryOpen(enabled = true) {
	const publicApi = usePublicApi();
	return useQuery({
		queryKey: ["guest", "gallery"],
		queryFn: () => publicApi.sessions({}, undefined, 1).then((page) => page.items.length > 0, () => false),
		enabled,
	});
}

/** Whether a session is published; the public API answers 404 alike for private and missing sessions. */
function usePublishedSession(id: string | undefined) {
	const publicApi = usePublicApi();
	return useQuery({
		queryKey: ["guest", "session", id],
		queryFn: () => publicApi.session(id!).then(() => true, () => false),
		enabled: id !== undefined,
	});
}

/**
 * Sends a signed-out visitor on: the home page opens the public gallery when a project is published, and a link to a
 * published session opens its public page. Statistics are always public; everything else asks for the password.
 */
function GuestRedirect() {
	const location = useLocation();
	const home = location.pathname === "/";
	const sessionId = matchPath("/s/:id", location.pathname)?.params.id;
	const gallery = useGalleryOpen(home);
	const published = usePublishedSession(sessionId);
	if (location.pathname === "/statistics") return <Navigate to={{ pathname: "/public/statistics", search: location.search }} replace />;
	const probe = home ? gallery : sessionId !== undefined ? published : undefined;
	if (probe?.isPending) return null;
	if (probe?.data) {
		const pathname = home ? "/public" : `/public/s/${encodeURIComponent(sessionId!)}`;
		return <Navigate to={{ pathname, search: location.search }} replace />;
	}
	return <Navigate to={loginPath(location)} replace />;
}

const RELOAD_KEY = "pika-auth-reload";
/** At most one reload this often, so a proxy that keeps answering 401 can't put the page in a reload loop. */
const RELOAD_INTERVAL_MS = 10_000;

/** The browser's page; tests replace `reload`. */
export const browserPage = { reload: () => window.location.reload() };

/** Reloads the page so the reverse proxy can authenticate it again, unless it reloaded for that moments ago. */
function reloadForProxy(): void {
	try {
		const last = Number(sessionStorage.getItem(RELOAD_KEY));
		if (Date.now() - last < RELOAD_INTERVAL_MS) return;
		sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
	} catch {
		// Without storage, reload anyway.
	}
	browserPage.reload();
}

/**
 * Sends a signed-out browser to the public pages it may see or to the login page when the server needs a password, and
 * to the login page when any request gets a 401 in password mode.
 * Behind an authenticating proxy (or with no authentication) the 401 comes from the proxy, so the page reloads instead.
 */
export function AuthGate() {
	const api = useApi();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const locationRef = useRef(location);
	locationRef.current = location;
	const me = useMe();

	useEffect(
		() =>
			api.onUnauthorized(() => {
				// The last known mode: pika's password form is useless when the proxy signs users in.
				const mode = authModeOf(queryClient.getQueryData<Me>(ME_KEY));
				if (mode === "proxy" || mode === "none") return reloadForProxy();
				queryClient.setQueryData<Me>(ME_KEY, SIGNED_OUT);
				navigate(loginPath(locationRef.current), { replace: true });
			}),
		[api, queryClient, navigate],
	);

	// Pages query the read API as they mount; before `me` first answers, a signed-out browser would get 401s.
	if (!me.isFetched) return null;
	if (needsLogin(me.data)) return <GuestRedirect />;
	return <Outlet />;
}
