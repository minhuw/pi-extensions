import { useEffect, useRef } from "react";
import type { Location } from "react-router";
import type { PikaApi, VisitorView } from "../lib/api";

function viewForLocation(location: Location): VisitorView | null {
	if (location.pathname === "/public" || location.pathname === "/public/") {
		const project = new URLSearchParams(location.search).get("project");
		return project ? { page: "gallery", project } : { page: "gallery" };
	}
	const match = /^\/public\/s\/([^/]+)\/?$/.exec(location.pathname);
	if (!match) return null;
	try {
		const sessionId = decodeURIComponent(match[1]!);
		return sessionId && new TextEncoder().encode(sessionId).length <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/u.test(sessionId)
			? { page: "session", sessionId } : null;
	} catch {
		return null;
	}
}

/** Count transitions between meaningful pages, including returning from an untracked public route. */
export function useVisitorView(api: PikaApi, location: Location, guestView: boolean) {
	const view = viewForLocation(location);
	const key = view ? JSON.stringify(view) : null;
	const previous = useRef<string | null | undefined>(undefined);
	useEffect(() => {
		if (previous.current === key) return;
		previous.current = key;
		if (!guestView && key) void api.visitorView(JSON.parse(key) as VisitorView).catch(() => {});
	}, [api, guestView, key]);
}
