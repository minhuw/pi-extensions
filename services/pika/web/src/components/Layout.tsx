import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, Outlet, useLocation, useMatch, useNavigate, useResolvedPath } from "react-router";
import { authModeOf, useApi } from "../lib/api";
import { guestPath, setGuestView } from "../lib/guestView";
import { useShortcuts } from "../lib/keyboard";
import { RELAY_BADGE_POLL_MS, useHealth, useOnlineSessions } from "../lib/relay";
import { useTheme, type Theme } from "../lib/theme";
import { useMe } from "./AuthGate";
import { Icon, PikaLogo, type IconName } from "./icons";
import { cx } from "./ui";

export const ScrollRootContext = createContext<HTMLElement | null>(null);

/** The main pane's scroll element; page virtualizers scroll with it. */
export function useScrollRoot(): HTMLElement | null {
	return useContext(ScrollRootContext);
}

interface SigningOut {
	/** True from the moment this browser starts signing out; pages stop polling so no request races the sign-out. */
	signingOut: boolean;
	setSigningOut: (value: boolean) => void;
}

const SigningOutContext = createContext<SigningOut>({ signingOut: false, setSigningOut: () => {} });

export function useSigningOut(): SigningOut {
	return useContext(SigningOutContext);
}

// Set like the navigation's names (13.5px, 15px icons), and narrower on phones, where every control is an icon.
export const BAND_CONTROL =
	"flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-[13.5px] font-medium text-band-muted hover:bg-band-hover hover:text-band-ink sm:px-2";

/**
 * The sign band: the app's frame, black with the thin white stripe of the transit manual's signs. It carries the
 * wordmark, the navigation, and the few controls every page shares.
 */
export function SignBand({ home, children, controls }: { home: string; children?: ReactNode; controls?: ReactNode }) {
	return (
		<header
			className="relative flex h-12 shrink-0 items-center gap-1 bg-band pr-1.5 pl-3 text-band-ink sm:gap-2 sm:pr-3 sm:pl-4 before:absolute before:inset-x-0 before:top-[5px] before:h-px before:bg-band-ink/85 dark:border-b dark:border-band-ink/30"
			data-sign-band=""
		>
			<Link to={home} className="mr-1 flex h-8 shrink-0 items-center gap-2 rounded-sm pr-1 text-[17px] font-semibold tracking-[-0.01em] sm:mr-3">
				<PikaLogo size={22} className="shrink-0" />
				{/* Phones keep the logo alone, leaving the band's width to the navigation and controls. */}
				<span className="max-sm:sr-only">pika</span>
			</Link>
			{children}
			<div className="ml-auto flex shrink-0 items-center gap-1">{controls}</div>
		</header>
	);
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className={BAND_CONTROL}
			aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
			title={theme === "dark" ? "Light theme" : "Dark theme"}
			data-theme-toggle=""
		>
			<Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
		</button>
	);
}

/**
 * A tab of the band's navigation, underlined while its page is open. `within` lists path prefixes of pages that belong
 * to the tab without being its page, such as a session under Sessions: the tab stays underlined there, so the band
 * still says where you are, and is the current item (`aria-current="true"`) rather than the current page. `compact`
 * sets a tab like the controls beside it on the band's right: always its icon, and its name only on wide screens.
 */
export function NavItem({
	to,
	icon,
	children,
	end,
	within,
	badge,
	compact = false,
	className,
}: {
	to: string;
	icon: IconName;
	children: ReactNode;
	end?: boolean;
	within?: string[];
	badge?: ReactNode;
	compact?: boolean;
	className?: string;
}) {
	const { pathname } = useLocation();
	const fit = useContext(BandFitContext);
	const current = useMatch({ path: useResolvedPath(to).pathname, end: end ?? false }) !== null;
	const inside = !current && (within?.some((prefix) => pathname.startsWith(prefix)) ?? false);
	return (
		<Link
			to={to}
			aria-current={current ? "page" : inside ? "true" : undefined}
			title={compact && typeof children === "string" ? children : undefined}
			className={cx(
				// Phones, where the tabs are icons, set them tighter so all of them fit down to a 320px screen.
				"relative flex h-12 shrink-0 items-center gap-2 px-1.5 text-[13.5px] font-medium whitespace-nowrap sm:px-2.5",
				"after:absolute after:inset-x-1.5 after:bottom-0 after:h-[3px] sm:after:inset-x-2.5",
				current || inside ? "text-band-ink after:bg-band-ink" : "text-band-muted hover:text-band-ink hover:after:bg-band-ink/35",
				className,
			)}
		>
			{/* Phones keep only the icons; the names stay for assistive technology. */}
			<Icon name={icon} size={15} className={cx("shrink-0", !compact && (fit === "names" ? "md:hidden" : fit !== "icons" && "md:max-lg:hidden"))} />
			{/* A crowded band drops the names of the compact tabs first, then of the sections. */}
			<span className={compact ? (fit === "full" ? "max-xl:sr-only" : "sr-only") : fit === "icons" ? "sr-only" : "max-md:sr-only"}>{children}</span>
			{badge}
		</Link>
	);
}

/**
 * Search on the band's right: a field that opens the search page with what was typed, so any page can search. Phones,
 * where the field has no room, get the search page's tab instead, and so does the search page itself, whose own field
 * takes over: the tab is underlined there, like any other open page.
 */
export function BandSearch({ path, label, inputRef }: { path: string; label: string; inputRef: RefObject<HTMLInputElement | null> }) {
	const navigate = useNavigate();
	const open = useMatch({ path: useResolvedPath(path).pathname, end: true }) !== null;
	const [value, setValue] = useState("");
	// A crowded band (see `BandNav`) trades the field for the search page's tab, as phones do.
	const crowded = useContext(BandFitContext) !== "full";
	const tab = (
		<NavItem to={path} icon="search" compact className={open || crowded ? undefined : "sm:hidden"}>
			Search
		</NavItem>
	);
	if (open) return tab;
	const leave = () => {
		setValue("");
		inputRef.current?.blur();
	};
	return (
		<>
			<form
				role="search"
				aria-label={label}
				onSubmit={(event) => {
					event.preventDefault();
					// As typed: on the search page a trailing space marks the last word finished.
					const query = value.trimStart();
					leave();
					navigate(query.trim() ? `${path}?${new URLSearchParams({ q: query })}` : path);
				}}
				className={cx(
					"group flex h-8 max-w-[480px] min-w-[104px] flex-1 cursor-text items-center gap-2 self-center rounded-sm border border-band-ink/20 bg-band-hover px-2.5 text-band-muted hover:border-band-ink/40 focus-within:border-band-ink focus-within:text-band-ink max-sm:hidden",
					crowded && "hidden",
				)}
				onClick={() => inputRef.current?.focus()}
				data-band-search=""
			>
				<Icon name="search" size={15} className="shrink-0" />
				<input
					ref={inputRef}
					type="search"
					value={value}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") leave();
					}}
					placeholder="Search"
					aria-label={label}
					enterKeyHint="search"
					className="min-w-0 flex-1 bg-transparent text-[13.5px] text-band-ink outline-none placeholder:text-band-muted [&::-webkit-search-cancel-button]:bg-band-muted"
				/>
				{/* The shortcut while the field waits, on screens wide enough to have a keyboard; typing hides it. */}
				<kbd
					aria-hidden="true"
					className="hidden h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-sm border border-band-ink/35 px-1 font-sans text-[11px] leading-none group-focus-within:hidden lg:inline-flex"
				>
					/
				</kbd>
			</form>
			{tab}
		</>
	);
}

/** `/` focuses the band's search field where it shows, and opens the search page where it doesn't, such as on phones. */
export function useBandSearchShortcut(path: string, inputRef: RefObject<HTMLInputElement | null>) {
	const navigate = useNavigate();
	const { pathname } = useLocation();
	// The search page handles `/` itself by focusing its own input.
	useShortcuts(
		pathname === path
			? {}
			: {
					"/": () => {
						const input = inputRef.current;
						if (input && input.getClientRects().length > 0) input.focus();
						else navigate(path);
					},
				},
	);
}

/** Online sessions in the band; hidden when the server has no relay or it is off. */
function ActiveSessionsItem() {
	const { sessions, availability } = useOnlineSessions(false);
	if (availability !== "on") return null;
	const count = sessions.data?.items.length ?? 0;
	return (
		<NavItem
			to="/active"
			icon="pulse"
			badge={
				count > 0 && (
					// Beside the name; where the tab is only its icon, smaller and on the icon's corner, so the tab stays narrow. The
					// icon is centred in its tab there, so the badge starts just right of the tab's centre.
					<span className="shrink-0 max-md:absolute max-md:top-[8px] max-md:left-[calc(50%+3px)]" data-online-count="">
						<span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-band-ink px-1 text-[11px] leading-none font-semibold text-band max-md:h-[14px] max-md:min-w-[14px] max-md:px-[3px] max-md:text-[9.5px] max-md:ring-2 max-md:ring-band">
							{count}
						</span>
						<span className="sr-only"> online</span>
					</span>
				)
			}
		>
			Active sessions
		</NavItem>
	);
}

/** Chatrooms in the band; hidden when the server has no relay or it is off. */
function ChatroomsItem() {
	const { availability } = useOnlineSessions(false);
	if (availability !== "on") return null;
	return (
		<NavItem to="/chatrooms" icon="message" end within={["/chatrooms/"]}>
			Chatrooms
		</NavItem>
	);
}
/** Nodes in the band; hidden unless the server has nodes on. */
function NodesItem() {
	const { data } = useHealth();
	if (!data?.features?.includes("nodes")) return null;
	return (
		<NavItem to="/nodes" icon="terminal">
			Nodes
		</NavItem>
	);
}

/** Opens this page as a visitor who isn't signed in sees it: published trajectories only, loaded anonymously. */
function GuestViewLink() {
	const { pathname, search } = useLocation();
	return (
		<Link
			to={guestPath(pathname, search)}
			onClick={() => setGuestView(true)}
			className={BAND_CONTROL}
			title="See this page as a visitor who isn't signed in sees it"
			data-guest-view=""
		>
			{/* The name only on wide screens: below them the band's width goes to the navigation's names. */}
			<Icon name="eye" size={15} />
			<span className="max-xl:sr-only">View as guest</span>
		</Link>
	);
}

function SignOutButton() {
	const api = useApi();
	const me = useMe();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { setSigningOut } = useSigningOut();
	if (authModeOf(me.data) !== "password" || !me.data?.authenticated) return null;
	const signOut = async () => {
		setSigningOut(true);
		try {
			await api.logout();
		} finally {
			queryClient.removeQueries();
			navigate("/login", { replace: true });
		}
	};
	return (
		// Like View as guest: the icon always, and the name only on wide screens.
		<button type="button" onClick={() => void signOut()} className={BAND_CONTROL} title="Sign out">
			<Icon name="signOut" size={15} />
			<span className="max-xl:sr-only">Sign out</span>
		</button>
	);
}

/** The server's version and the commit it was built from, so you can tell whether it runs the latest build. */
export function ServerVersion({ className }: { className?: string }) {
	const { data } = useHealth();
	if (!data?.version) return null;
	const build = data.revision ? `${data.version} (${data.revision})` : data.version;
	return (
		<div
			className={cx("select-text text-[11.5px] whitespace-nowrap", className)}
			title={data.revision ? `pika ${data.version}, built from commit ${data.revision}` : `pika ${data.version}`}
			data-server-version=""
		>
			pika {build}
		</div>
	);
}

/**
 * The band's navigation takes the width between the wordmark and the controls: the sections from the left, and search
 * with the pages beside the controls from the right, the search field growing into the room between them.
 */
export const BAND_NAV = "flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]";
export const BAND_NAV_END = "ml-auto flex min-w-0 flex-1 items-stretch justify-end gap-1 pl-3 sm:gap-1.5 lg:pl-6";

/**
 * How much the band gives up to fit its tabs, one step at a time: nothing; the search field, which becomes the search
 * page's tab, and the names of the compact tabs beside it (Search, Settings); the sections' icons, as between the md
 * and lg breakpoints; or the sections' names instead, leaving icons. Which tabs show depends on the server (relay, nodes), so the band
 * measures rather than guessing from the screen's width.
 */
export type BandFit = "full" | "search" | "names" | "icons";
const FITS: readonly BandFit[] = ["full", "search", "names", "icons"];

const BandFitContext = createContext<BandFit>("full");

/**
 * The band's tabs overflow their room, or run under the controls at the right (`data-band-end`), whose content
 * spills leftwards over the tabs once the field is at its least width.
 */
export function bandCrowded(nav: HTMLElement): boolean {
	if (nav.scrollWidth > nav.clientWidth + 1) return true;
	const end = nav.querySelector<HTMLElement>(":scope > [data-band-end]");
	if (!end) return false;
	const tabs = [...nav.children].filter((child) => child !== end && child.getClientRects().length > 0);
	const first = [...end.children].find((child) => child.getClientRects().length > 0);
	const last = tabs.at(-1);
	if (!last || !first) return false;
	return last.getBoundingClientRect().right > first.getBoundingClientRect().left;
}

/**
 * The band's navigation, fitted to its width: on every resize and every tab that appears or goes it starts from
 * `full` and gives up one step at a time, before the browser paints, until the tabs fit. Past `icons` it scrolls.
 */
export function BandNav({ label, children }: { label: string; children: ReactNode }) {
	const ref = useRef<HTMLElement>(null);
	const [fit, setFit] = useState<BandFit>("full");
	const [round, setRound] = useState(0);

	useLayoutEffect(() => {
		const nav = ref.current;
		if (!nav) return;
		const next = FITS[FITS.indexOf(fit) + 1];
		if (next && bandCrowded(nav)) setFit(next);
	}, [fit, round]);

	useLayoutEffect(() => {
		const nav = ref.current;
		if (!nav || typeof ResizeObserver === "undefined") return;
		const again = () => {
			setFit("full");
			setRound((value) => value + 1);
		};
		// The band's width, and each tab's: a tab changes size when Aileron replaces the fallback font or a badge
		// appears. A fit runs before the browser paints, so the observer sees only its result, which it saw before.
		const resize = new ResizeObserver(again);
		const observe = () => {
			resize.disconnect();
			resize.observe(nav);
			for (const child of nav.querySelectorAll(":scope > *, :scope > [data-band-end] > *")) resize.observe(child);
		};
		observe();
		// Tabs that appear once the server's health or relay answers; a fit changes classes, never children.
		const mutation = new MutationObserver(() => {
			observe();
			again();
		});
		mutation.observe(nav, { childList: true, subtree: true });
		return () => {
			resize.disconnect();
			mutation.disconnect();
		};
	}, []);

	return (
		<BandFitContext.Provider value={fit}>
			<nav ref={ref} className={BAND_NAV} aria-label={label} data-band-fit={fit}>
				{children}
			</nav>
		</BandFitContext.Provider>
	);
}

export function Layout({ children }: { children?: ReactNode }) {
	const { theme, toggle } = useTheme();
	const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
	const [signingOut, setSigningOut] = useState(false);
	const signingOutValue = useMemo(() => ({ signingOut, setSigningOut }), [signingOut]);
	const { pathname } = useLocation();
	const searchRef = useRef<HTMLInputElement>(null);
	// Keeps the band's badge and the session page's Online badge fresh; Active sessions and Chatrooms poll faster themselves.
	const onRelayPage = pathname === "/active" || pathname === "/chatrooms" || pathname.startsWith("/chatrooms/");
	useOnlineSessions(signingOut || onRelayPage ? false : RELAY_BADGE_POLL_MS);
	useBandSearchShortcut("/search", searchRef);

	return (
		<SigningOutContext.Provider value={signingOutValue}>
			<div className="flex h-full flex-col bg-page text-ink">
				<SignBand
					home="/"
					controls={
						<>
							<ThemeToggle theme={theme} onToggle={toggle} />
							<GuestViewLink />
							<SignOutButton />
						</>
					}
				>
					<BandNav label="Main">
						<NavItem to="/" icon="sessions" end within={["/s/"]}>
							Sessions
						</NavItem>
						<NavItem to="/statistics" icon="statistics">
							Statistics
						</NavItem>
						<NavItem to="/extensions" icon="tool">
							Extensions
						</NavItem>
						<NavItem to="/runs" icon="herder">
							Herder runs
						</NavItem>
						<ActiveSessionsItem />
						<ChatroomsItem />
						<NodesItem />
						<NavItem to="/devices" icon="device">
							Devices
						</NavItem>
						<NavItem to="/memory" icon="memory">
							Memory
						</NavItem>
						<div className={BAND_NAV_END} data-band-end="">
							<BandSearch path="/search" label="Search every session" inputRef={searchRef} />
							<NavItem to="/settings" icon="settings" compact>
								Settings
							</NavItem>
						</div>
					</BandNav>
				</SignBand>
				<main ref={setScrollRoot} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto" data-scroll-root="">
					<ScrollRootContext.Provider value={scrollRoot}>{children ?? <Outlet />}</ScrollRootContext.Provider>
				</main>
				{/* The colophon: a thin line under every page, with the server's build in its corner and out of the band. */}
				<footer className="flex h-6 shrink-0 items-center justify-end border-t border-line px-4 text-muted">
					<Link to="/docs" className="mr-auto text-xs hover:text-ink hover:underline">Documentation</Link>
					<ServerVersion />
				</footer>
			</div>
		</SigningOutContext.Provider>
	);
}
