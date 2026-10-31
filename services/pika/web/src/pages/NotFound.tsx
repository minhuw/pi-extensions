import { Link as OwnerLink } from "react-router";
import { PikaLink as Link } from "../components/PikaLink";
import { BUTTON, cx, PAGE_COLUMN } from "../components/ui";
import { useApi } from "../lib/api";
import { inGuestView, setGuestView } from "../lib/guestView";

export function NotFoundPage({ what = "page" }: { what?: string }) {
	// The owner, looking at a session as a guest, came from a session that exists: a guest misses it because it isn't
	// published. The note is the owner's alone; visitors get the plain page.
	const ownerNote = useApi().publicView && what === "session" && inGuestView();
	return (
		<div className={cx(PAGE_COLUMN, "pt-9")} data-state="not-found">
			<h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.02em]">This {what} doesn’t exist</h1>
			<p className="mt-2 text-[14px] text-muted">
				<span className="tnum">404.</span> It may not have been uploaded yet, or the link is wrong.
			</p>
			{ownerNote && (
				<p className="mt-4 max-w-[60ch] border-l-2 border-ink pl-3 text-[13.5px]" data-guest-note="">
					Guest view: visitors get this page because this session’s project isn’t published. Publish it in{" "}
					<OwnerLink to="/settings" onClick={() => setGuestView(false)} className="underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink">
						Settings
					</OwnerLink>{" "}
					to share it.
				</p>
			)}
			<Link to="/" className={cx(BUTTON.secondary, "mt-6")}>
				Back to sessions
			</Link>
		</div>
	);
}
