import { Link } from "react-router";
import { cx, PAGE_COLUMN } from "../components/ui";

export function NotFoundPage({ what = "page" }: { what?: string }) {
	return (
		<div className={cx(PAGE_COLUMN, "pt-32 text-center")} data-state="not-found">
			<div className="text-[64px] leading-none font-semibold text-muted/40">404</div>
			<h1 className="mt-4 text-[24px] font-semibold">This {what} doesn’t exist</h1>
			<p className="mt-2 text-muted">It may not have been uploaded yet, or the link is wrong.</p>
			<Link to="/" className="mt-6 inline-block rounded-sm border border-line px-3 py-1 text-[14px] hover:bg-hover">
				Back to sessions
			</Link>
		</div>
	);
}
