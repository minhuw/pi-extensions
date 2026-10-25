import { Icon, type IconName } from "../components/icons";
import { PageTitle } from "../components/ui";

function Placeholder({ title, icon, children }: { title: string; icon: IconName; children: string }) {
	return (
		<div className="mx-auto max-w-[900px] px-12 pt-16">
			<PageTitle>{title}</PageTitle>
			<div className="mt-8 flex items-center gap-3 rounded-md bg-soft px-4 py-3 text-muted">
				<Icon name={icon} />
				{children}
			</div>
		</div>
	);
}

export function HerderRunsPage() {
	return (
		<Placeholder title="Herder runs" icon="herder">
			Herder runs will be listed here.
		</Placeholder>
	);
}

export function SearchPage() {
	return (
		<Placeholder title="Search" icon="search">
			Search across sessions is coming soon.
		</Placeholder>
	);
}
