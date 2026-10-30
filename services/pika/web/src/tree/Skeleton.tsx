import { Skeleton, SkeletonLines } from "../components/ui";

/** The agent tree while its chunk or its data loads. */
export function AgentTreeSkeleton() {
	return (
		<div className="space-y-3 px-6 pt-4" aria-busy="true" aria-label="Loading the agent tree">
			<Skeleton className="h-5 w-1/3" />
			<SkeletonLines lines={6} />
		</div>
	);
}
