import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useApi } from "../lib/api";
import { isLive, TRACE_REFRESH_MS } from "../lib/liveness";
import { buildFamily } from "./model";

export function treeKey(sessionId: string) {
	return ["tree", sessionId];
}

export interface FamilyOptions {
	/** How often a family with a live session refetches. */
	refreshMs?: number;
	/** How long a family nobody shows stays cached; the client's default when unset. */
	gcTime?: number;
}

/** The family of `sessionId`, refetched while any of its sessions is live. */
export function useFamily(sessionId: string, { refreshMs = TRACE_REFRESH_MS, gcTime }: FamilyOptions = {}) {
	const api = useApi();
	const tree = useQuery({
		queryKey: treeKey(sessionId),
		queryFn: () => api.tree(sessionId),
		...(gcTime !== undefined ? { gcTime } : {}),
		refetchInterval: (query) => (query.state.data?.nodes?.some((node) => isLive(node.lastAt)) ? refreshMs : false),
	});
	// A refetch that finds the family unchanged keeps `data`; its new time still ends a session that went idle.
	const updatedAt = tree.dataUpdatedAt;
	const family = useMemo(() => (tree.data ? buildFamily(tree.data, Math.max(Date.now(), updatedAt)) : undefined), [tree.data, updatedAt]);
	return { tree, family };
}
