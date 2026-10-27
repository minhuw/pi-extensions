import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { authModeOf, useApi } from "../lib/api";
import { useShortcuts } from "../lib/keyboard";
import { RELAY_BADGE_POLL_MS, useHealth, useOnlineSessions } from "../lib/relay";
import { useTheme, type Theme } from "../lib/theme";
import { useMe } from "./AuthGate";
import { Icon, PikaLogo, type IconName } from "./icons";
import { cx, Pill } from "./ui";

const ScrollRootContext = createContext<HTMLElement | null>(null);

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

const SIDEBAR_KEY = "pika-sidebar";

function initialSidebarOpen(): boolean {
	try {
		return localStorage.getItem(SIDEBAR_KEY) !== "closed";
	} catch {
		return true;
	}
}

function NavItem({ to, icon, children, end, badge }: { to: string; icon: IconName; children: ReactNode; end?: boolean; badge?: ReactNode }) {
	return (
		<NavLink
			to={to}
			end={end}
			className={({ isActive }) =>
				cx(
					"flex h-[30px] items-center gap-2.5 rounded-sm px-2 text-[14px] hover:bg-hover",
					isActive ? "bg-hover font-medium text-ink" : "text-muted",
				)
			}
		>
			<Icon name={icon} className="shrink-0" />
			<span className="truncate">{children}</span>
			{badge}
		</NavLink>
	);
}

function SidebarSection({ title, items, param, icon }: { title: string; items: string[]; param: string; icon: IconName }) {
	if (items.length === 0) return null;
	return (
		<div className="mt-5">
			<div className="px-2 pb-1 text-[12px] font-medium text-muted">{title}</div>
			{items.slice(0, 8).map((item) => (
				<Link
					key={item}
					to={`/?${param}=${encodeURIComponent(item)}`}
					className="flex h-[28px] items-center gap-2.5 rounded-sm px-2 text-[14px] text-muted hover:bg-hover"
					title={item}
				>
					<Icon name={icon} className="shrink-0" size={14} />
					<span className="truncate">{item}</span>
				</Link>
			))}
		</div>
	);
}

/** Online sessions in the sidebar; hidden when the server has no relay or it is off. */
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
					<span className="ml-auto shrink-0" data-online-count="">
						<Pill tone="accent">{count}</Pill>
						<span className="sr-only"> online</span>
					</span>
				)
			}
		>
			Active sessions
		</NavItem>
	);
}

function Sidebar({ onClose, theme, onToggleTheme }: { onClose: () => void; theme: Theme; onToggleTheme: () => void }) {
	const api = useApi();
	const facets = useQuery({ queryKey: ["facets"], queryFn: () => api.facets(), staleTime: 60_000 });
	const me = useMe();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { setSigningOut } = useSigningOut();
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
		<aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-line bg-sidebar" aria-label="Sidebar">
			<div className="flex h-12 items-center gap-2 px-3">
				<Link to="/" className="flex h-7 items-center gap-1.5 rounded-sm pr-1.5 pl-1 font-semibold hover:bg-hover">
					<PikaLogo size={22} className="shrink-0" />
					pika
				</Link>
				<button
					type="button"
					onClick={onClose}
					className="ml-auto rounded-sm p-1 text-muted hover:bg-hover"
					aria-label="Collapse sidebar"
					title="Collapse sidebar"
				>
					<Icon name="sidebar" />
				</button>
			</div>
			<nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="Main">
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
				<NavItem to="/search" icon="search">
					Search
				</NavItem>
				<SidebarSection title="Projects" items={facets.data?.projects ?? []} param="project" icon="folder" />
				<SidebarSection title="Devices" items={facets.data?.devices ?? []} param="device" icon="device" />
			</nav>
			<div className="border-t border-line px-2 py-2">
				<button
					type="button"
					onClick={onToggleTheme}
					className="flex h-[30px] w-full items-center gap-2.5 rounded-sm px-2 text-[14px] text-muted hover:bg-hover"
					aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
					data-theme-toggle=""
				>
					<Icon name={theme === "dark" ? "sun" : "moon"} />
					{theme === "dark" ? "Light theme" : "Dark theme"}
				</button>
				{authModeOf(me.data) === "password" && me.data?.authenticated && (
					<button
						type="button"
						onClick={() => void signOut()}
						className="flex h-[30px] w-full items-center gap-2.5 rounded-sm px-2 text-[14px] text-muted hover:bg-hover"
					>
						<Icon name="external" />
						Sign out
					</button>
				)}
				<ServerVersion className="px-2 pt-1.5" />
			</div>
		</aside>
	);
}

/** The server's version and the commit it was built from, so you can tell whether it runs the latest build. */
export function ServerVersion({ className }: { className?: string }) {
	const { data } = useHealth();
	if (!data?.version) return null;
	const build = data.revision ? `${data.version} (${data.revision})` : data.version;
	return (
		<div
			className={cx("select-text text-[12px] text-muted", className)}
			title={data.revision ? `pika ${data.version}, built from commit ${data.revision}` : `pika ${data.version}`}
			data-server-version=""
		>
			pika {build}
		</div>
	);
}

export function Layout({ children }: { children?: ReactNode }) {
	const [open, setOpen] = useState(initialSidebarOpen);
	const { theme, toggle } = useTheme();
	const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
	const [signingOut, setSigningOut] = useState(false);
	const signingOutValue = useMemo(() => ({ signingOut, setSigningOut }), [signingOut]);
	const navigate = useNavigate();
	const { pathname } = useLocation();
	// Keeps the sidebar badge and the session page's Online badge fresh; the Active sessions page polls faster itself.
	useOnlineSessions(signingOut || pathname === "/active" ? false : RELAY_BADGE_POLL_MS);
	// The search page handles `/` itself by focusing its input.
	useShortcuts(pathname === "/search" ? {} : { "/": () => navigate("/search") });

	const setSidebar = (value: boolean) => {
		setOpen(value);
		try {
			localStorage.setItem(SIDEBAR_KEY, value ? "open" : "closed");
		} catch {
			// Not persisted when storage is unavailable.
		}
	};

	return (
		<SigningOutContext.Provider value={signingOutValue}>
			<div className="flex h-full bg-page text-ink">
				{open && <Sidebar onClose={() => setSidebar(false)} theme={theme} onToggleTheme={toggle} />}
				<main ref={setScrollRoot} className="relative h-full min-w-0 flex-1 overflow-y-auto" data-scroll-root="">
					{!open && (
						<button
							type="button"
							onClick={() => setSidebar(true)}
							className="fixed top-3 left-3 z-10 rounded-sm bg-page p-1 text-muted hover:bg-hover"
							aria-label="Open sidebar"
							title="Open sidebar"
						>
							<Icon name="sidebar" />
						</button>
					)}
					<ScrollRootContext.Provider value={scrollRoot}>{children ?? <Outlet />}</ScrollRootContext.Provider>
				</main>
			</div>
		</SigningOutContext.Provider>
	);
}
