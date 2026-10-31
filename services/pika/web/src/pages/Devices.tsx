import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ME_KEY, SIGNED_OUT, useMe } from "../components/AuthGate";
import { Icon } from "../components/icons";
import { useSigningOut } from "../components/Layout";
import { BUTTON, Callout, ConfirmDialog, cx, Dialog, EmptyState, ErrorState, Page, PageTitle, Pill, SkeletonLines } from "../components/ui";
import { ApiError, authModeOf, useApi } from "../lib/api";
import {
	DEVICE_NAME_RULE,
	deviceOptions,
	formatCountdown,
	isValidDeviceName,
	normalizePairingCode,
	orderPairings,
	shortUserAgent,
} from "../lib/devices";
import { formatDateTime, formatRelative } from "../lib/format";
import { LAYOUT_GUARD_MS, useNow, useSettling } from "../lib/hooks";
import type { BrowserSession, Device, Pairing } from "../lib/types";

export const PAIRINGS_POLL_MS = 2_000;
/** After an approval, the devices list refetches this long at most, until the approved machine has polled for its token. */
export const APPROVED_WATCH_MS = 60_000;
// Approve stays disabled this long after requests come or go.
export { LAYOUT_GUARD_MS };

const PAIRINGS_KEY = ["pairings"] as const;
const DEVICES_KEY = ["devices"] as const;
const BROWSER_SESSIONS_KEY = ["browser-sessions"] as const;
const NO_DEVICES: readonly Device[] = [];

type Notice = { tone: "green" | "red"; text: string };
/** The device an approval made or continued, which exists (or gets its new token) only once its machine polls. */
type Approved = { id?: string; until: number };

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function H2({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
	return (
		<div className="mt-9 mb-2 flex items-center gap-2">
			<h2 className="text-[16px] font-semibold">{children}</h2>
			{aside}
		</div>
	);
}

function Code({ children }: { children: ReactNode }) {
	return <code className="code-chip">{children}</code>;
}

const TH = "h-7 px-2 pb-1 text-left align-bottom text-[12px] font-medium whitespace-nowrap text-muted";
const TD = "px-2 py-1.5 align-middle";

/** The error code in an `ApiError`'s body, such as `unknown_device`. */
function errorCode(cause: unknown): string | undefined {
	if (!(cause instanceof ApiError) || !cause.body || typeof cause.body !== "object") return undefined;
	const error = (cause.body as { error?: unknown }).error;
	return typeof error === "string" ? error : undefined;
}

const INPUT = "mt-1 h-8 w-full max-w-[320px] rounded-sm border border-line bg-page px-2.5 text-[14px] outline-none focus:border-ink";
const SELECT = "mt-1 h-8 w-full max-w-[320px] rounded-sm border border-line bg-page px-2 text-[14px] outline-none focus:border-ink";

function PairingCard({
	pairing,
	now,
	highlighted,
	settling,
	devices,
	onHandled,
	onRefresh,
}: {
	pairing: Pairing;
	now: number;
	highlighted: boolean;
	/** The list just changed; Approve waits until it settles. */
	settling: boolean;
	/** Devices the request could continue instead, when the server did not recognize it. */
	devices: readonly Device[];
	onHandled: (code: string, notice: Notice, approved?: string) => void;
	onRefresh: () => void;
}) {
	const api = useApi();
	const match = pairing.match;
	// The id of the device this machine continues, or null for a new device.
	const [continues, setContinues] = useState<string | null>(match?.id ?? null);
	const nameFor = (id: string | null): string => {
		if (id === null) return pairing.name;
		if (id === match?.id) return match.name;
		return devices.find((item) => item.id === id)?.name ?? id;
	};
	const [name, setName] = useState(() => nameFor(continues));
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const ref = useRef<HTMLElement>(null);

	useEffect(() => {
		if (highlighted) ref.current?.scrollIntoView?.({ block: "center" });
	}, [highlighted]);

	// A name the user has not changed follows the choice.
	const choose = (id: string | null) => {
		if (name === nameFor(continues)) setName(nameFor(id));
		setContinues(id);
		setError(null);
	};

	const valid = isValidDeviceName(name);
	const remaining = Date.parse(pairing.expiresAt) - now;
	const expired = !(remaining > 0);
	const canApprove = valid && !expired && !busy && !settling;
	const options = useMemo(() => deviceOptions(devices), [devices]);

	const approve = async () => {
		setBusy(true);
		setError(null);
		const sent = name.trim();
		try {
			const result = await api.approvePairing(pairing.code, { name: sent, continues });
			const approved = result?.name ?? sent;
			const continued = result?.continued ?? continues !== null;
			onHandled(
				pairing.code,
				{ tone: "green", text: continued ? `Approved ${approved}; it continues the existing device.` : `Approved ${approved}.` },
				typeof result?.device === "string" ? result.device : undefined,
			);
		} catch (cause) {
			const code = errorCode(cause);
			if (code === "unknown_device") {
				setError("That device no longer exists. Choose another, or add a new device.");
				onRefresh();
			} else if (code === "invalid_name") {
				setError(`The server refused this name. ${DEVICE_NAME_RULE}`);
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
			onHandled(pairing.code, { tone: "green", text: `Denied the request from ${pairing.name}.` });
		} catch (cause) {
			setError(cause instanceof ApiError && cause.status === 404 ? "This request expired or was already handled." : messageOf(cause));
			onRefresh();
		} finally {
			setBusy(false);
		}
	};

	const inputId = `pairing-name-${pairing.code}`;
	const selectId = `pairing-continues-${pairing.code}`;
	const choiceName = `pairing-choice-${pairing.code}`;
	return (
		<section
			ref={ref}
			aria-label={`Pairing request ${pairing.code}`}
			data-pairing={pairing.code}
			data-pairing-match={match?.id}
			data-highlighted={highlighted ? "" : undefined}
			className={cx("rounded-sm border px-4 py-3", highlighted ? "border-ink bg-accent-soft shadow-[inset_0_0_0_1px_var(--color-ink)]" : "border-line")}
		>
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
				<span className="font-mono text-[28px] leading-tight font-semibold tracking-[0.08em]" data-pairing-code="">
					{pairing.code}
				</span>
				<span className={cx("ml-auto text-[13px] tabular-nums", expired ? "text-red" : "text-muted")} data-expires="">
					{expired ? "Expired" : `Expires in ${formatCountdown(remaining)}`}
				</span>
			</div>
			<div className="mt-1 text-[14px] break-words" data-pairing-name="">
				<span className="text-muted">Requested name</span> <span className="font-medium">{pairing.name}</span>
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
			{match ? (
				<>
					<div className="mt-3 rounded-sm bg-soft px-3 py-2 text-[14px] break-words" data-pairing-recognized={match.by}>
						Recognized as <span className="font-medium">{match.name}</span> {match.by === "key" ? "by its device key" : "by its current token"}
					</div>
					<fieldset className="mt-3">
						<legend className="text-[13px] text-muted">Approve as</legend>
						<label className="mt-1 flex items-start gap-2 text-[14px]">
							<input
								type="radio"
								name={choiceName}
								checked={continues === match.id}
								onChange={() => choose(match.id)}
								className="mt-1 accent-ink"
							/>
							<span className="min-w-0 break-words">
								Continue {match.name}
								<span className="block text-[13px] text-muted">
									{match.active ? "Same history; its current token stops working." : "Same history."}
								</span>
							</span>
						</label>
						<label className="mt-1 flex items-start gap-2 text-[14px]">
							<input type="radio" name={choiceName} checked={continues === null} onChange={() => choose(null)} className="mt-1 accent-ink" />
							<span>Add as a new device</span>
						</label>
					</fieldset>
				</>
			) : (
				<>
					<div className="mt-3 text-[14px]" data-pairing-new={continues === null ? "" : undefined}>
						{continues === null ? "Approves a new device." : `Continues ${nameFor(continues)}; its current token stops working.`}
					</div>
					{options.length > 0 && (
						<>
							<label htmlFor={selectId} className="mt-2 block text-[13px] text-muted">
								Continue an existing device instead
							</label>
							<select id={selectId} value={continues ?? ""} onChange={(event) => choose(event.target.value || null)} className={SELECT}>
								<option value="">New device</option>
								{options.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</>
					)}
				</>
			)}
			<label htmlFor={inputId} className="mt-3 block text-[13px] text-muted">
				Device name
			</label>
			<input
				id={inputId}
				value={name}
				onChange={(event) => setName(event.target.value)}
				spellCheck={false}
				autoComplete="off"
				aria-invalid={!valid}
				className={INPUT}
			/>
			{!valid && <div className="mt-1 text-[13px] text-red">{DEVICE_NAME_RULE}</div>}
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
	devices,
	onHandled,
}: {
	pairCode: string | null;
	handled: ReadonlySet<string>;
	devices: readonly Device[];
	onHandled: (code: string, notice: Notice, approved?: string) => void;
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
			devices={devices}
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
							<h3 className="pt-4 text-[14px] font-semibold" data-other-requests="">
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

function RenameDialog({
	device,
	onDone,
	onCancel,
	onClosedError,
}: {
	device: Device;
	onDone: (renamed: { id: string; name: string }) => void;
	onCancel: () => void;
	/** A rename the dialog was closed during (Esc, Cancel) failed: the page says so, since the dialog cannot. */
	onClosedError: (text: string) => void;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [name, setName] = useState(device.name);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const open = useRef(true);
	useEffect(() => {
		inputRef.current?.select();
		open.current = true;
		return () => {
			open.current = false;
		};
	}, []);
	const valid = isValidDeviceName(name);
	const inputId = `rename-${device.id}`;

	const save = async () => {
		if (!valid || busy) return;
		setBusy(true);
		setError(null);
		try {
			const result = await api.renameDevice(device.id, name.trim());
			onDone(result ?? { id: device.id, name: name.trim() });
		} catch (cause) {
			const code = errorCode(cause);
			const gone = cause instanceof ApiError && cause.status === 404;
			if (gone) void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
			if (!open.current) {
				onClosedError(
					gone ? `Could not rename ${device.name}: it no longer exists.` : `Could not rename ${device.name}: ${code === "invalid_name" ? "the server refused the name." : messageOf(cause)}`,
				);
				return;
			}
			if (code === "invalid_name") setError(`The server refused this name. ${DEVICE_NAME_RULE}`);
			else if (gone) setError("This device no longer exists.");
			else setError(messageOf(cause));
			setBusy(false);
		}
	};

	return (
		<Dialog title={`Rename ${device.name}`} onCancel={onCancel} label="rename">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<label htmlFor={inputId} className="mt-3 block text-[13px] text-muted">
					Device name
				</label>
				<input
					ref={inputRef}
					id={inputId}
					value={name}
					onChange={(event) => {
						setName(event.target.value);
						setError(null);
					}}
					spellCheck={false}
					autoComplete="off"
					aria-invalid={!valid}
					className={cx(INPUT, "max-w-none")}
				/>
				{!valid && <div className="mt-1 text-[13px] text-red">{DEVICE_NAME_RULE}</div>}
				{error && (
					<div role="alert" className="mt-2 text-[13px] text-red">
						{error}
					</div>
				)}
				<div className="mt-2 text-[13px] text-muted">
					Its id stays <code className="font-mono">{device.id}</code>, so its sessions and token are unchanged.
				</div>
				<div className="mt-5 flex justify-end gap-2">
					<button type="button" onClick={onCancel} className={BUTTON.secondary}>
						Cancel
					</button>
					<button type="submit" disabled={!valid || busy} className={BUTTON.primary}>
						Rename
					</button>
				</div>
			</form>
		</Dialog>
	);
}

/** Copies `text`; `navigator.clipboard` needs a secure context, which a pika on plain http to a LAN address is not. */
async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		try {
			return document.execCommand("copy");
		} catch {
			return false;
		} finally {
			area.remove();
		}
	}
}

export const DEVICE_ID_SHOWN = 8;

/** A device's id, shortened to its first characters, with the whole id in its title and a button that copies it. */
function DeviceId({ id, name }: { id: string; name: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1_500);
		return () => clearTimeout(timer);
	}, [copied]);
	const short = [...id].length > DEVICE_ID_SHOWN ? `${[...id].slice(0, DEVICE_ID_SHOWN).join("")}…` : id;
	return (
		<span className="flex items-center gap-1 text-[11.5px] text-muted">
			<span className="font-mono text-muted" title={id} data-device-id={id}>
				{short}
			</span>
			<button
				type="button"
				onClick={() => void copyText(id).then(setCopied)}
				title={copied ? "Copied" : "Copy id"}
				aria-label={copied ? `Copied the id of ${name}` : `Copy the id of ${name}`}
				className="rounded-sm p-0.5 text-muted opacity-60 hover:bg-hover hover:opacity-100 focus-visible:opacity-100"
				data-copy-device-id=""
			>
				<Icon name={copied ? "check" : "copy"} size={12} />
			</button>
		</span>
	);
}

function DeviceSection({ devices, onNotice }: { devices: UseQueryResult<{ items: Device[] }>; onNotice: (notice: Notice) => void }) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [revoking, setRevoking] = useState<Device | null>(null);
	const [renaming, setRenaming] = useState<Device | null>(null);
	const [busy, setBusy] = useState(false);
	const items = devices.data?.items ?? [];

	const revoke = async (device: Device) => {
		setBusy(true);
		try {
			await api.revokeDevice(device.id);
			onNotice({ tone: "green", text: `Revoked ${device.name}.` });
		} catch (cause) {
			onNotice({ tone: "red", text: `Could not revoke ${device.name}: ${messageOf(cause)}` });
		} finally {
			setBusy(false);
			setRevoking(null);
			void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
		}
	};

	const renamed = (device: Device, result: { id: string; name: string }) => {
		setRenaming(null);
		onNotice({ tone: "green", text: `Renamed ${device.name} to ${result.name}.` });
		// Names show in the filters, sessions, runs, and relay lists too.
		void queryClient.invalidateQueries();
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
					<table className="w-full border-collapse text-[13px]" data-device-list="">
						<thead>
							<tr className="border-b border-ink">
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
								<tr
									key={device.id}
									className="border-b border-line hover:bg-hover"
									data-device={device.id}
									data-device-name={device.name}
								>
									<td className={TD}>
										<span className="flex min-w-0 items-start gap-2">
											<span className="min-w-0">
												<span className="block font-medium break-words" data-device-label="">
													{device.name}
												</span>
												<DeviceId id={device.id} name={device.name} />
											</span>
										</span>
									</td>
									<td className={cx(TD, "whitespace-nowrap text-muted")}>
										{formatDateTime(device.createdAt)}{" "}
										<Pill>
											{device.createdVia === "pairing" ? "paired" : "CLI"}
										</Pill>
									</td>
									<td className={cx(TD, "tnum whitespace-nowrap text-muted")} title={device.lastSeenAt ? formatDateTime(device.lastSeenAt) : undefined}>
										{device.lastSeenAt ? formatRelative(device.lastSeenAt) : "never"}
									</td>
									{/* Wraps at hyphens and dots first; only a host that does not fit at all breaks inside a word. */}
									<td className={cx(TD, "min-w-[9rem] text-muted [overflow-wrap:anywhere]")} data-last-host="">
										{device.lastHost || "—"}
									</td>
									<td className={cx(TD, "text-right whitespace-nowrap")}>
										<button type="button" onClick={() => setRenaming(device)} className={cx(BUTTON.quiet, "!px-2")} aria-label={`Rename ${device.name}`}>
											Rename
										</button>
										<button type="button" onClick={() => setRevoking(device)} className={cx(BUTTON.quiet, "!px-2")} aria-label={`Revoke ${device.name}`}>
											Revoke
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{renaming && (
				<RenameDialog
					device={renaming}
					onDone={(result) => renamed(renaming, result)}
					onCancel={() => setRenaming(null)}
					onClosedError={(text) => onNotice({ tone: "red", text })}
				/>
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
					<Code>/pika login</Code>. Sessions it already uploaded stay. Device id <Code>{revoking.id}</Code>.
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
					<table className="w-full border-collapse text-[13px]" data-browser-sessions="">
						<thead>
							<tr className="border-b border-ink">
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
								<tr key={session.id} className="border-b border-line hover:bg-hover" data-browser-session={session.id}>
									<td className={TD} title={session.userAgent}>
										<span className="flex min-w-0 flex-wrap items-center gap-2 break-all">
											{shortUserAgent(session.userAgent)}
											{session.current && <Pill tone="green">This browser</Pill>}
										</span>
									</td>
									<td className={cx(TD, "font-mono text-[12px] text-muted")}>{session.ip || "—"}</td>
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
	const { signingOut } = useSigningOut();
	// The server creates an approved device, or gives a continued one its new token, when its machine next polls, so
	// the list refetches until that shows, or for APPROVED_WATCH_MS at most.
	const [approved, setApproved] = useState<Approved | null>(null);
	const devices = useQuery({
		queryKey: DEVICES_KEY,
		queryFn: () => api.devices(),
		refetchInterval: approved && !signingOut ? PAIRINGS_POLL_MS : false,
	});
	const [notice, setNotice] = useState<Notice | null>(null);
	// Codes approved or denied on this page, so the deep link doesn't then report them missing.
	const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
	// The approved device's row as it was listed at approval: it is done once the row shows with a new token.
	const before = useRef<Device | undefined>(undefined);

	useEffect(() => {
		if (!approved) return;
		const timer = setTimeout(() => setApproved(null), Math.max(0, approved.until - Date.now()));
		return () => clearTimeout(timer);
	}, [approved]);
	useEffect(() => {
		if (!approved?.id || !devices.data) return;
		const row = devices.data.items.find((item) => item.id === approved.id);
		if (row && row.createdAt !== before.current?.createdAt) setApproved(null);
	}, [approved, devices.data]);

	const onHandled = (code: string, next: Notice, device?: string) => {
		setHandled((codes) => new Set(codes).add(normalizePairingCode(code)));
		setNotice(next);
		if (next.tone === "green" && device !== undefined) {
			before.current = devices.data?.items.find((item) => item.id === device);
			setApproved({ id: device, until: Date.now() + APPROVED_WATCH_MS });
		}
		void queryClient.invalidateQueries({ queryKey: PAIRINGS_KEY });
		void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
	};

	return (
		<Page className="pb-24">
			<PageTitle>Devices</PageTitle>
			<p className="mt-2 text-[14px] text-muted">Machines that upload to pika, and requests from new ones to join.</p>
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
			<PairingSection pairCode={pairCode} handled={handled} devices={devices.data?.items ?? NO_DEVICES} onHandled={onHandled} />
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
