/**
 * The owner's guest view: the public pages, opened from the owner's band to see what a visitor who isn't signed in
 * sees. Public pages always load anonymously; this tab-local mark only lets their band offer the way back.
 */
const GUEST_VIEW_KEY = "pika-guest-view";

export function inGuestView(): boolean {
	try {
		return sessionStorage.getItem(GUEST_VIEW_KEY) === "1";
	} catch {
		return false;
	}
}

export function setGuestView(on: boolean): void {
	try {
		if (on) sessionStorage.setItem(GUEST_VIEW_KEY, "1");
		else sessionStorage.removeItem(GUEST_VIEW_KEY);
	} catch {
		// Without storage the public band offers Sign in, which leads back all the same.
	}
}

/** The public page in place of an owner's page: the gallery or a session's public page, keeping the query string. */
export function guestPath(pathname: string, search: string): string {
	if (pathname === "/") return `/public${search}`;
	const session = /^\/s\/([^/]+)$/.exec(pathname);
	if (session) return `/public/s/${session[1]}${search}`;
	return "/public";
}
