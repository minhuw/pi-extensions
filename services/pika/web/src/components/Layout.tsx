import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { authModeOf, useApi } from "../lib/api";
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

const BAND_CONTROL = "flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 text-[13px] font-medium text-band-muted hover:bg-band-hover hover:text-band-ink";

/**
 * The sign band: the app's frame, black with the thin white stripe of the transit manual's signs. It carries the
 * wordmark, the navigation, and the few controls every page shares.
 */
export function SignBand({ home, children, controls }: { home: string; children?: ReactNode; controls?: ReactNode }) {
	return (
		<header
			className="relative flex h-12 shrink-0 items-center gap-2 bg-band pr-3 pl-4 text-band-ink before:absolute before:inset-x-0 before:top-[5px] before:h-px before:bg-band-ink/85 dark:border-b dark:border-band-ink/30"
			data-sign-band=""
		>
			<Link to={home} className="mr-3 flex h-8 shrink-0 items-center gap-2 rounded-sm pr-1 text-[17px] font-semibold tracking-[-0.01em]">
				<PikaLogo size={22} className="shrink-0" />
				pika
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
			<Icon name={theme === "dark" ? "sun" : "moon"} />
		</button>
	);
}

function NavItem({ to, icon, children, end, badge, hint }: { to: string; icon: IconName; children: ReactNode; end?: boolean; badge?: ReactNode; hint?: string }) {
	return (
		<NavLink
			to={to}
			end={end}
			className={({ isActive }) =>
				cx(
					"relative flex h-12 shrink-0 items-center gap-2 px-2.5 text-[13.5px] font-medium whitespace-nowrap",
					"after:absolute after:inset-x-2.5 after:bottom-0 after:h-[3px]",
					isActive ? "text-band-ink after:bg-band-ink" : "text-band-muted hover:text-band-ink",
				)
			}
		>
			{/* Phones keep only the icons; the names stay for assistive technology. */}
			<Icon name={icon} size={15} className="shrink-0 md:max-lg:hidden" />
			<span className="max-md:sr-only">{children}</span>
			{badge}
			{hint && (
				<kbd
					aria-hidden="true"
					className="hidden h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-band-ink/35 px-1 font-sans text-[11px] leading-none lg:inline-flex"
				>
					{hint}
				</kbd>
			)}
		</NavLink>
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
					<span className="shrink-0" data-online-count="">
						<span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-band-ink px-1 text-[11px] leading-none font-semibold text-band">
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
		<button type="button" onClick={() => void signOut()} className={BAND_CONTROL}>
			<Icon name="external" className="max-md:hidden" />
			Sign out
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

export function Layout({ children }: { children?: ReactNode }) {
	const { theme, toggle } = useTheme();
	const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
	const [signingOut, setSigningOut] = useState(false);
	const signingOutValue = useMemo(() => ({ signingOut, setSigningOut }), [signingOut]);
	const navigate = useNavigate();
	const { pathname } = useLocation();
	// Keeps the band's badge and the session page's Online badge fresh; the Active sessions page polls faster itself.
	useOnlineSessions(signingOut || pathname === "/active" ? false : RELAY_BADGE_POLL_MS);
	// The search page handles `/` itself by focusing its input.
	useShortcuts(pathname === "/search" ? {} : { "/": () => navigate("/search") });

	return (
		<SigningOutContext.Provider value={signingOutValue}>
			<div className="flex h-full flex-col bg-page text-ink">
				<SignBand
					home="/"
					controls={
						<>
							<ServerVersion className="mr-2 text-band-muted max-xl:hidden" />
							<ThemeToggle theme={theme} onToggle={toggle} />
							<SignOutButton />
						</>
					}
				>
					<nav className="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]" aria-label="Main">
						<NavItem to="/" icon="sessions" end>
							Sessions
						</NavItem>
						<NavItem to="/runs" icon="herder">
							Herder runs
						</NavItem>
						<ActiveSessionsItem />
						<NavItem to="/devices" icon="key">
							Devices
						</NavItem>
						<NavItem to="/search" icon="search" hint="/">
							Search
						</NavItem>
						<NavItem to="/settings" icon="settings">
							Settings
						</NavItem>
					</nav>
				</SignBand>
				<main ref={setScrollRoot} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto" data-scroll-root="">
					<ScrollRootContext.Provider value={scrollRoot}>{children ?? <Outlet />}</ScrollRootContext.Provider>
				</main>
			</div>
		</SigningOutContext.Provider>
	);
}
