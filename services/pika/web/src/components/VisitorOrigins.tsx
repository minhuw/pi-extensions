import { useQuery } from "@tanstack/react-query";
import { useApi } from "../lib/api";
import { formatCount } from "../lib/format";
import { EmptyState, ErrorState, SkeletonLines } from "./ui";

function countryName(country: string | null): string {
	if (!country) return "Unknown";
	try {
		return new Intl.DisplayNames(["en"], { type: "region" }).of(country) || country;
	} catch {
		return country;
	}
}

function Breakdown({ title, rows }: { title: string; rows: { name: string; views: number; dailyVisitors: number }[] }) {
	return <div className="min-w-0">
		<h3 className="text-[14px] font-semibold">{title}</h3>
		{rows.length === 0 ? <p className="mt-3 text-[13px] text-muted">No data yet.</p> :
			<div className="mt-2 overflow-x-auto"><table className="w-full min-w-[320px] text-left text-[13px]">
				<thead className="border-b border-ink text-muted"><tr><th scope="col" className="py-2 font-medium">{title}</th><th scope="col" className="px-3 text-right font-medium">Views</th><th scope="col" className="text-right font-medium">Sum of daily estimated visitors</th></tr></thead>
				<tbody>{rows.map((row, i) => <tr key={i} className="border-b border-line"><th scope="row" className="break-all py-2 text-left font-medium">{row.name}</th><td className="tnum px-3 text-right">{formatCount(row.views)}</td><td className="tnum text-right">{formatCount(row.dailyVisitors)}</td></tr>)}</tbody>
			</table></div>}
	</div>;
}

export function VisitorOriginsSection() {
	const api = useApi();
	const origins = useQuery({ queryKey: ["settings", "visitor-origins"], queryFn: () => api.visitorOrigins() });
	return <section className="mt-12" aria-labelledby="visitor-origins-title">
		<h2 id="visitor-origins-title" className="text-[16px] font-semibold">Visitor origins</h2>
		{origins.isPending ? <div className="mt-6"><SkeletonLines /></div> : origins.isError ?
			<ErrorState error={origins.error} onRetry={() => void origins.refetch()} /> : origins.data.mode === "off" ?
			<div className="mt-3 max-w-[72ch] text-[14px] text-muted"><p>Visitor analytics is off. Remove the server option or environment variable that disabled it to restore the default.</p><p className="mt-2">Behind a trusted proxy, also set <code className="code-chip">PIKA_TRUST_PROXY=1</code>.</p></div> :
			<VisitorData data={origins.data} />}
	</section>;
}

function VisitorData({ data }: { data: import("../lib/api").VisitorOrigins }) {
	return <div className="mt-3">
		<p className="max-w-[90ch] text-[13px] text-muted">Last 30 UTC dates, including today. Unfiltered gallery views have no project. The visitor figure sums daily estimates, not unique people over 30 days. Estimates use daily rotating IP hashes; people sharing an address count once, and requests without an IP are omitted. If the daily storage limit is reached, views from new groups count under Unknown without a project or visitor estimate.</p>
		<p className="mt-2 max-w-[90ch] text-[13px] text-muted">The owner's marked guest view and views from Tailscale addresses are excluded. Other direct public visits by the owner may still be counted.</p>
		<dl className="mt-5 flex flex-wrap gap-x-12 gap-y-4"><div><dt className="text-[13px] text-muted">Total views</dt><dd className="tnum text-[22px] font-semibold">{formatCount(data.views)}</dd></div><div><dt className="text-[13px] text-muted">Sum of daily estimated visitors</dt><dd className="tnum text-[22px] font-semibold">{formatCount(data.dailyVisitors)}</dd></div></dl>
		{data.views === 0 && <EmptyState title="No views yet">Public gallery and trajectory views will appear here after they are recorded.</EmptyState>}
		<div className="mt-6 grid gap-8 lg:grid-cols-2"><Breakdown title="Countries" rows={data.countries.map((row) => ({ ...row, name: countryName(row.country) }))} /><Breakdown title="Projects" rows={data.projects.map((row) => ({ ...row, name: row.project }))} /></div>
		<details className="mt-8 max-w-[520px]"><summary className="cursor-pointer text-[14px] font-semibold">Daily views · last 30 UTC dates</summary><div className="mt-2 overflow-x-auto"><table className="w-full text-left text-[13px]"><thead className="border-b border-ink text-muted"><tr><th scope="col" className="py-2 font-medium">UTC date</th><th scope="col" className="text-right font-medium">Views</th></tr></thead><tbody>{data.daily.map(({ date, views }) => <tr key={date} className="border-b border-line"><th scope="row" className="tnum py-1 text-left font-medium">{date}</th><td className="tnum text-right">{formatCount(views)}</td></tr>)}</tbody></table></div></details>
	</div>;
}
