import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useMe } from "../components/AuthGate";
import { PikaLogo } from "../components/icons";
import { ServerVersion } from "../components/Layout";
import { BUTTON, cx } from "../components/ui";
import { ApiError, authModeOf, useApi } from "../lib/api";
import { formatWait } from "../lib/format";

/** Only same-app paths are followed after signing in. */
export function safeNext(value: string | null): string {
	if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/login")) return "/";
	return value;
}

export function loginErrorMessage(cause: unknown): string {
	if (cause instanceof ApiError && cause.status === 401) return "Wrong password";
	if (cause instanceof ApiError && cause.status === 429) {
		return cause.retryAfter === undefined
			? "Too many attempts. Try again later."
			: `Too many attempts. Try again in ${formatWait(cause.retryAfter)}.`;
	}
	return cause instanceof Error ? cause.message : String(cause);
}

export function LoginPage() {
	const api = useApi();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const me = useMe();

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await api.login(password);
			queryClient.removeQueries();
			navigate(safeNext(params.get("next")), { replace: true });
		} catch (cause) {
			setError(loginErrorMessage(cause));
			setBusy(false);
		}
	};

	// A reverse proxy or no authentication has nothing to sign in to.
	const mode = authModeOf(me.data);
	if (mode === "proxy" || mode === "none") return <Navigate to={safeNext(params.get("next"))} replace />;

	return (
		<main className="flex min-h-full flex-col items-center justify-center bg-page px-6 py-12 text-ink">
			<form onSubmit={(event) => void submit(event)} className="w-full max-w-[340px] rounded-sm border border-ink bg-page" aria-label="Sign in">
				{/* A small sign band: the app's black frame, with the manual's thin white stripe. */}
				<div className="relative flex h-12 items-center gap-2 bg-band px-4 text-band-ink before:absolute before:inset-x-0 before:top-[5px] before:h-px before:bg-band-ink/85">
					<PikaLogo size={22} className="shrink-0" />
					<span className="text-[17px] font-semibold tracking-[-0.01em]" aria-hidden="true">
						pika
					</span>
				</div>
				<div className="px-6 pt-5 pb-6">
					<h1 className="text-[21px] leading-tight font-semibold tracking-[-0.01em]">Sign in to pika</h1>
					<p className="mt-1 text-[13.5px] text-muted">This server is password protected.</p>
					<label className="mt-5 block text-[13px] font-medium" htmlFor="pika-password">
						Password
					</label>
					<input
						id="pika-password"
						type="password"
						autoComplete="current-password"
						autoFocus
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						className="mt-1 h-10 w-full rounded-sm border border-line bg-page px-2.5 text-[14px] outline-none focus:border-ink"
					/>
					{error && (
						<div role="alert" className="mt-2 text-[13px] text-red">
							{error}
						</div>
					)}
					<button type="submit" disabled={busy || password === ""} className={cx(BUTTON.primary, "mt-4 h-9 w-full justify-center")}>
						{busy ? "Signing in…" : "Continue"}
					</button>
				</div>
			</form>
			<ServerVersion className="mt-3 text-center text-muted" />
		</main>
	);
}
