import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useMe } from "../components/AuthGate";
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
		<div className="flex h-full items-center justify-center bg-page px-6 text-ink">
			<form onSubmit={(event) => void submit(event)} className="w-full max-w-[320px]" aria-label="Sign in">
				<div className="mb-8 flex items-center gap-2 font-semibold">
					<span className="flex h-6 w-6 items-center justify-center rounded-sm bg-ink text-[13px] text-page">p</span>
					pika
				</div>
				<h1 className="text-[24px] font-semibold">Sign in</h1>
				<p className="mt-1 text-[14px] text-muted">This server is password protected.</p>
				<label className="mt-6 block text-[13px] text-muted" htmlFor="pika-password">
					Password
				</label>
				<input
					id="pika-password"
					type="password"
					autoComplete="current-password"
					autoFocus
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					className="mt-1 h-9 w-full rounded-sm border border-line bg-page px-2.5 text-[15px] outline-none focus:border-accent/60"
				/>
				{error && (
					<div role="alert" className="mt-2 text-[13px] text-red">
						{error}
					</div>
				)}
				<button
					type="submit"
					disabled={busy || password === ""}
					className="mt-4 h-9 w-full rounded-sm bg-accent text-[14px] font-medium text-white hover:opacity-90 disabled:opacity-50"
				>
					{busy ? "Signing in…" : "Continue"}
				</button>
			</form>
		</div>
	);
}
