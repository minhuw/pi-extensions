import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { useApi } from "../lib/api";
import type { Me } from "../lib/types";

export const ME_KEY = ["me"] as const;

export function useMe() {
	const api = useApi();
	return useQuery({ queryKey: ME_KEY, queryFn: () => api.me(), staleTime: 60_000, retry: false });
}

function loginPath(location: { pathname: string; search: string }): string {
	return `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

/** Sends the user to the login page when the server needs a password, or when any request gets a 401. */
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
				queryClient.setQueryData<Me>(ME_KEY, { authenticated: false, passwordRequired: true });
				navigate(loginPath(locationRef.current), { replace: true });
			}),
		[api, queryClient, navigate],
	);

	// Pages query the read API as they mount; before `me` first answers, a signed-out browser would get 401s.
	if (!me.isFetched) return null;
	if (me.data?.passwordRequired && !me.data.authenticated) return <Navigate to={loginPath(location)} replace />;
	return <Outlet />;
}
