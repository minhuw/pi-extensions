import { PikaLink as Link } from "../components/PikaLink";
import { BUTTON, cx, PAGE_COLUMN } from "../components/ui";

export function NotFoundPage({ what = "page" }: { what?: string }) {
	return (
		<div className={cx(PAGE_COLUMN, "pt-9")} data-state="not-found">
			<h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.02em]">This {what} doesn’t exist</h1>
			<p className="mt-2 text-[14px] text-muted">
				<span className="tnum">404.</span> It may not have been uploaded yet, or the link is wrong.
			</p>
			<Link to="/" className={cx(BUTTON.secondary, "mt-6")}>
				Back to sessions
			</Link>
		</div>
	);
}
