import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ME_KEY, SIGNED_OUT, useMe } from "../components/AuthGate";
import { Icon } from "../components/icons";
import { useSigningOut } from "../components/Layout";
import { BUTTON, Callout, ConfirmDialog, cx, EmptyState, ErrorState, Page, PageTitle, Pill, SkeletonLines } from "../components/ui";
import { ApiError, authModeOf, useApi } from "../lib/api";
import { formatCountdown, isValidDeviceName, normalizePairingCode, orderPairings, shortUserAgent } from "../lib/devices";
import { formatDateTime, formatRelative } from "../lib/format";
import { LAYOUT_GUARD_MS, useNow, useSettling } from "../lib/hooks";
import type { BrowserSession, Device, Pairing } from "../lib/types";

export const PAIRINGS_POLL_MS = 2_000;
// Approve stays disabled this long after requests come or go.
export { LAYOUT_GUARD_MS };

const PAIRINGS_KEY = ["pairings"] as const;
const DEVICES_KEY = ["devices"] as const;
const BROWSER_SESSIONS_KEY = ["browser-sessions"] as const;

type Notice = { tone: "green" | "red"; text: string };

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function H2({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
	return (
		<div className="mt-10 mb-2 flex items-center gap-2">
			<h2 className="text-[20px] font-semibold">{children}</h2>
			{aside}
		</div>
	);
}

function Code({ children }: { children: ReactNode }) {
	return <code className="code-chip">{children}</code>;
}

const TH = "px-2 py-1.5 text-left text-[13px] font-normal text-muted";
const TD = "px-2 py-2 align-middle";

function PairingCard({
	pairing,
	now,
	highlighted,
	settling,
	existingNames,
	onHandled,
	onRefresh,
}: {
	pairing: Pairing;
	now: number;
	highlighted: boolean;
	/** The list just changed; Approve waits until it settles. */
	settling: boolean;
	existingNames: ReadonlySet<string> | undefined;
	onHandled: (code: string, notice: Notice) => void;
	onRefresh: () => void;
}) {
	const api = useApi();
	const [name, setName] = useState(pairing.device);
	const [replace, setReplace] = useState(false);
	// A name the server reported as taken, newer than the devices list.
	const [conflict, setConflict] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const ref = useRef<HTMLElement>(null);

	useEffect(() => {
		if (highlighted) ref.current?.scrollIntoView?.({ block: "center" });
	}, [highlighted]);

	const valid = isValidDeviceName(name);
	const exists = conflict === name || existingNames?.has(name) === true || (name === pairing.device && pairing.deviceExists);
	const remaining = Date.parse(pairing.expiresAt) - now;
	const expired = !(remaining > 0);
	const canApprove = valid && !expired && (!exists || replace) && !busy && !settling;

	const approve = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await api.approvePairing(pairing.code, exists && replace ? { name, replace: true } : { name });
			onHandled(pairing.code, { tone: "green", text: `Approved ${result?.device ?? name}. pi on that machine finishes logging in by itself.` });
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 409) {
				setConflict(name);
				setReplace(false);
				onRefresh();
			} else if (cause instanceof ApiError && cause.status === 404) {
				setError("This request expired or was already handled.");
				onRefresh();
			} else {
				setError(messageOf(cause));
			}
		} finally {
			setBusy(false);
		}
	};

	const deny = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.denyPairing(pairing.code);
			onHandled(pairing.code, { tone: "green", text: `Denied the request from ${pairing.device}.` });
		} catch (cause) {
			setError(cause instanceof ApiError && cause.status === 404 ? "This request expired or was already handled." : messageOf(cause));
			onRefresh();
		} finally {
			setBusy(false);
		}
	};

	const inputId = `pairing-name-${pairing.code}`;
	return (
		<section
			ref={ref}
			aria-label={`Pairing request ${pairing.code}`}
			data-pairing={pairing.code}
			data-highlighted={highlighted ? "" : undefined}
			className={cx("rounded-md border px-4 py-3", highlighted ? "border-accent bg-accent-soft ring-2 ring-accent/30" : "border-line")}
		>
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
				<span className="font-mono text-[28px] leading-tight font-semibold tracking-[0.08em]" data-pairing-code="">
					{pairing.code}
				</span>
				<span className={cx("ml-auto text-[13px] tabular-nums", expired ? "text-red" : "text-muted")} data-expires="">
					{expired ? "Expired" : `Expires in ${formatCountdown(remaining)}`}
				</span>
			</div>
			<div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-muted">
				{pairing.host && (
					<span className="flex min-w-0 items-center gap-1 break-all" data-pairing-host="">
						<Icon name="device" size={13} className="shrink-0" />
						{pairing.host}
					</span>
				)}
				{pairing.ip && (
					<span className="flex items-center gap-1">
						<Icon name="globe" size={13} />
						{pairing.ip}
					</span>
				)}
				{pairing.pikaVersion && <span className="min-w-0 break-all">pika {pairing.pikaVersion}</span>}
				<span title={formatDateTime(pairing.requestedAt)}>Requested {formatRelative(pairing.requestedAt, now)}</span>
			</div>
			<label htmlFor={inputId} className="mt-3 block text-[13px] text-muted">
				Device name
			</label>
			<input
				id={inputId}
				value={name}
				onChange={(event) => {
					setName(event.target.value);
					// Replacing was confirmed for the old name only.
					setReplace(false);
				}}
				spellCheck={false}
				autoComplete="off"
				aria-invalid={!valid}
				className="mt-1 h-8 w-full max-w-[320px] rounded-sm border border-line bg-page px-2.5 font-mono text-[14px] outline-none focus:border-accent/60"
			/>
			{!valid && <div className="mt-1 text-[13px] text-red">Use 1–64 letters, digits, dots, underscores, or hyphens.</div>}
			{valid && exists && (
				<div className="mt-2 rounded-sm bg-yellow-soft px-3 py-2 text-[14px]" data-device-exists="">
					<div className="break-all">A device named {name} exists.</div>
					<label className="mt-1 flex items-center gap-2">
						<input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
						Replace it
						<span className="text-[13px] text-muted">(its current token stops working)</span>
					</label>
				</div>
			)}
			{error && (
				<div role="alert" className="mt-2 text-[13px] text-red">
					{error}
				</div>
			)}
			<div className="mt-3 flex gap-2">
				<button
					type="button"
					onClick={() => void approve()}
					disabled={!canApprove}
					className={BUTTON.primary}
					aria-label={`Approve ${pairing.code}`}
				>
					Approve {pairing.code}
				</button>
				<button type="button" onClick={() => void deny()} disabled={busy} className={BUTTON.secondary}>
					Deny
				</button>
			</div>
		</section>
	);
}

function PairingSection({
	pairCode,
	handled,
	existingNames,
	onHandled,
}: {
	pairCode: string | null;
	handled: ReadonlySet<string>;
	existingNames: ReadonlySet<string> | undefined;
	onHandled: (code: string, notice: Notice) => void;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const { signingOut } = useSigningOut();
	// Polling stops while the tab is hidden (TanStack's refetchIntervalInBackground is off), and once signing out
	// starts: a poll the server answers after the session ends would get a 401.
	const pairings = useQuery({
		queryKey: PAIRINGS_KEY,
		queryFn: () => api.pairings(),
		refetchInterval: signingOut ? false : PAIRINGS_POLL_MS,
		staleTime: 0,
	});
	useEffect(() => {
		if (signingOut) void queryClient.cancelQueries({ queryKey: PAIRINGS_KEY });
	}, [signingOut, queryClient]);
	const items = pairings.data?.items ?? [];
	const now = useNow(items.length > 0);
	const wanted = pairCode ? normalizePairingCode(pairCode) : null;
	const { pinned, others } = orderPairings(items, wanted);
	const matched = pinned !== undefined;
	const settling = useSettling(
		pairings.data ? items.map((pairing) => pairing.code).sort().join(" ") : undefined,
		LAYOUT_GUARD_MS,
	);
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: PAIRINGS_KEY });
		void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
	};
	const card = (pairing: Pairing) => (
		<PairingCard
			key={pairing.code}
			pairing={pairing}
			now={now}
			highlighted={pairing === pinned}
			settling={settling}
			existingNames={existingNames}
			onHandled={onHandled}
			onRefresh={refresh}
		/>
	);

	return (
		<>
			{wanted !== null && pairings.isSuccess && !matched && !handled.has(wanted) && (
				<div className="mt-6" data-pairing-missing="">
					<Callout tone="yellow" icon="alert" title={`No pending request with code ${pairCode}`}>
						<div className="text-[14px]">
							It may have expired or already been handled. Run <Code>/pika login</Code> in pi again for a new code.
						</div>
					</Callout>
				</div>
			)}
			<H2 aside={items.length > 0 && <Pill tone="accent">{items.length}</Pill>}>Pairing requests</H2>
			{pairings.isPending ? (
				<SkeletonLines lines={2} />
			) : pairings.isError && !pairings.data ? (
				<ErrorState error={pairings.error} onRetry={() => void pairings.refetch()} />
			) : items.length === 0 ? (
				<p className="text-[14px] text-muted">
					No pending requests. Run <Code>/pika login</Code> in pi on the machine you want to add.
				</p>
			) : (
				<>
					<p className="mb-3 text-[14px] text-muted">Before you approve, check that the code matches the one pi shows on that machine.</p>
					<div className="space-y-3" data-pairing-list="">
						{pinned && card(pinned)}
						{pinned && others.length > 0 && (
							<h3 className="pt-3 text-[15px] font-semibold" data-other-requests="">
								Other requests
							</h3>
						)}
						{others.map(card)}
					</div>
				</>
			)}
		</>
	);
}

function DeviceSection({ devices, onNotice }: { devices: UseQueryResult<{ items: Device[] }>; onNotice: (notice: Notice) => void }) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [revoking, setRevoking] = useState<Device | null>(null);
	const [busy, setBusy] = useState(false);
	const items = devices.data?.items ?? [];

	const revoke = async (device: Device) => {
		setBusy(true);
		try {
			await api.revokeDevice(device.name);
			onNotice({ tone: "green", text: `Revoked ${device.name}.` });
		} catch (cause) {
			onNotice({ tone: "red", text: `Could not revoke ${device.name}: ${messageOf(cause)}` });
		} finally {
			setBusy(false);
			setRevoking(null);
			void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
		}
	};

	return (
		<>
			<H2>Devices</H2>
			{devices.isPending ? (
				<SkeletonLines lines={3} />
			) : devices.isError && !devices.data ? (
				<ErrorState error={devices.error} onRetry={() => void devices.refetch()} />
			) : items.length === 0 ? (
				<EmptyState title="No devices yet">
					In pi on the machine you want to add, run <Code>/pika login</Code> and approve its request here. Or create a token
					on the server with <Code>pika token create &lt;name&gt;</Code> and paste it into <Code>/pika login</Code>.
				</EmptyState>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full border-collapse text-[14px]" data-device-list="">
						<thead>
							<tr className="border-b border-line">
								<th className={TH}>Name</th>
								<th className={TH}>Added</th>
								<th className={TH}>Last seen</th>
								<th className={TH}>Last host</th>
								<th className={TH}>
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{items.map((device) => (
								<tr key={device.name} className="border-b border-line last:border-b-0 hover:bg-soft" data-device={device.name}>
									<td className={cx(TD, "font-medium")}>
										<span className="flex min-w-0 items-center gap-2 break-all">
											<Icon name="device" className="shrink-0 text-muted" />
											{device.name}
										</span>
									</td>
									<td className={cx(TD, "whitespace-nowrap text-muted")}>
										{formatDateTime(device.createdAt)}{" "}
										<Pill tone={device.createdVia === "pairing" ? "accent" : "neutral"}>
											{device.createdVia === "pairing" ? "paired" : "CLI"}
										</Pill>
									</td>
									<td className={cx(TD, "whitespace-nowrap text-muted")} title={device.lastSeenAt ? formatDateTime(device.lastSeenAt) : undefined}>
										{device.lastSeenAt ? formatRelative(device.lastSeenAt) : "never"}
									</td>
									<td className={cx(TD, "break-all text-muted")} data-last-host="">
										{device.lastHost || "—"}
									</td>
									<td className={cx(TD, "text-right")}>
										<button type="button" onClick={() => setRevoking(device)} className={BUTTON.quiet} aria-label={`Revoke ${device.name}`}>
											Revoke
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{revoking && (
				<ConfirmDialog
					title={`Revoke ${revoking.name}?`}
					confirmLabel="Revoke"
					busy={busy}
					onConfirm={() => void revoke(revoking)}
					onCancel={() => setRevoking(null)}
				>
					Its token stops working at once, so the machine stops uploading until it logs in again with{" "}
					<Code>/pika login</Code>. Sessions it already uploaded stay.
				</ConfirmDialog>
			)}
		</>
	);
}

function BrowserSessionSection({ onNotice }: { onNotice: (notice: Notice) => void }) {
	const api = useApi();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { setSigningOut } = useSigningOut();
	const sessions = useQuery({ queryKey: BROWSER_SESSIONS_KEY, queryFn: () => api.browserSessions() });
	const [confirmAll, setConfirmAll] = useState(false);
	const [busy, setBusy] = useState(false);
	const items = sessions.data?.items ?? [];

	const signedOut = () => {
		queryClient.removeQueries();
		queryClient.setQueryData(ME_KEY, SIGNED_OUT);
		navigate("/login", { replace: true });
	};

	const signOut = async (session: BrowserSession) => {
		setBusy(true);
		if (session.current) setSigningOut(true);
		try {
			await api.deleteBrowserSession(session.id);
		} catch (cause) {
			setBusy(false);
			setSigningOut(false);
			// A 401 already sent this browser to the login page.
			if (!(cause instanceof ApiError && cause.status === 401)) onNotice({ tone: "red", text: `Could not sign out that browser: ${messageOf(cause)}` });
			return;
		}
		if (session.current) return signedOut();
		setBusy(false);
		onNotice({ tone: "green", text: `Signed out ${shortUserAgent(session.userAgent)}.` });
		void queryClient.invalidateQueries({ queryKey: BROWSER_SESSIONS_KEY });
	};

	const signOutEverywhere = async () => {
		setBusy(true);
		setSigningOut(true);
		try {
			await api.revokeAllBrowserSessions();
			signedOut();
		} catch (cause) {
			setBusy(false);
			setSigningOut(false);
			setConfirmAll(false);
			if (!(cause instanceof ApiError && cause.status === 401)) onNotice({ tone: "red", text: `Could not sign out everywhere: ${messageOf(cause)}` });
		}
	};

	return (
		<>
			<H2
				aside={
					items.length > 0 && (
						<button type="button" onClick={() => setConfirmAll(true)} className={cx(BUTTON.secondary, "ml-auto")}>
							Sign out everywhere
						</button>
					)
				}
			>
				Browser sessions
			</H2>
			{sessions.isPending ? (
				<SkeletonLines lines={2} />
			) : sessions.isError && !sessions.data ? (
				<ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
			) : (
				<div className="overflow-x-auto">
					<table className="w-full border-collapse text-[14px]" data-browser-sessions="">
						<thead>
							<tr className="border-b border-line">
								<th className={TH}>Browser</th>
								<th className={TH}>IP</th>
								<th className={TH}>Signed in</th>
								<th className={TH}>Last seen</th>
								<th className={TH}>
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{items.map((session) => (
								<tr key={session.id} className="border-b border-line last:border-b-0 hover:bg-soft" data-browser-session={session.id}>
									<td className={TD} title={session.userAgent}>
										<span className="flex min-w-0 flex-wrap items-center gap-2 break-all">
											{shortUserAgent(session.userAgent)}
											{session.current && <Pill tone="accent">This browser</Pill>}
										</span>
									</td>
									<td className={cx(TD, "font-mono text-[13px] text-muted")}>{session.ip || "—"}</td>
									<td className={cx(TD, "whitespace-nowrap text-muted")}>{formatDateTime(session.createdAt)}</td>
									<td className={cx(TD, "whitespace-nowrap text-muted")} title={formatDateTime(session.lastSeenAt)}>
										{formatRelative(session.lastSeenAt)}
									</td>
									<td className={cx(TD, "text-right")}>
										<button
											type="button"
											disabled={busy}
											onClick={() => void signOut(session)}
											className={BUTTON.quiet}
											aria-label={session.current ? "Sign out this browser" : `Sign out ${shortUserAgent(session.userAgent)}`}
										>
											Sign out
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{confirmAll && (
				<ConfirmDialog
					title="Sign out everywhere?"
					confirmLabel="Sign out everywhere"
					busy={busy}
					onConfirm={() => void signOutEverywhere()}
					onCancel={() => setConfirmAll(false)}
				>
					Every browser signed in to pika, this one included, has to sign in again. Devices keep uploading.
				</ConfirmDialog>
			)}
		</>
	);
}

export function DevicesPage() {
	const api = useApi();
	const me = useMe();
	const mode = authModeOf(me.data);
	const queryClient = useQueryClient();
	const [params] = useSearchParams();
	const pairCode = params.get("pair");
	const devices = useQuery({ queryKey: DEVICES_KEY, queryFn: () => api.devices() });
	const existingNames = useMemo(() => (devices.data ? new Set(devices.data.items.map((device) => device.name)) : undefined), [devices.data]);
	const [notice, setNotice] = useState<Notice | null>(null);
	// Codes approved or denied on this page, so the deep link doesn't then report them missing.
	const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());

	const onHandled = (code: string, next: Notice) => {
		setHandled((codes) => new Set(codes).add(normalizePairingCode(code)));
		setNotice(next);
		void queryClient.invalidateQueries({ queryKey: PAIRINGS_KEY });
		void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
	};

	return (
		<Page className="pb-24">
			<PageTitle>Devices</PageTitle>
			<p className="mt-2 text-[15px] text-muted">Machines that upload to pika, and requests from new ones to join.</p>
			{mode === "none" && (
				<div className="mt-6">
					<Callout tone="yellow" icon="alert" title="pika has no authentication">
						<div className="text-[14px]">
							Anyone who can reach this server can read every session and approve devices. Set a password with{" "}
							<Code>pika password set</Code>, or run behind a reverse proxy that signs you in with <Code>PIKA_AUTH=proxy</Code>.
						</div>
					</Callout>
				</div>
			)}
			{notice && (
				<div className="mt-6" role="status" data-notice={notice.tone}>
					<Callout tone={notice.tone} icon={notice.tone === "red" ? "alert" : "info"}>
						<div className="text-[14px]">{notice.text}</div>
					</Callout>
				</div>
			)}
			<PairingSection pairCode={pairCode} handled={handled} existingNames={existingNames} onHandled={onHandled} />
			<DeviceSection devices={devices} onNotice={setNotice} />
			{mode === "password" && <BrowserSessionSection onNotice={setNotice} />}
			{mode === "proxy" && (
				<>
					<H2>Browser sessions</H2>
					<Callout title="Your reverse proxy handles sign-in">
						<div className="text-[14px]">pika keeps no browser sessions in proxy mode. Sign out through your proxy.</div>
					</Callout>
				</>
			)}
		</Page>
	);
}
