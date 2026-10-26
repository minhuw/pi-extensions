import { createContext, useContext, type ComponentType } from "react";
import type { ChildSession, Entry } from "../lib/types";

export interface SessionViewContextValue {
	sessionId: string;
	/** Child sessions keyed by the parent tool call that spawned them. */
	childrenByToolCall: Map<string, ChildSession>;
	/** Every child of each tool call, oldest first; workflow calls spawn several. */
	childGroups?: Map<string, ChildSession[]>;
	/** Session ids from the page's session down to this one, for inline nesting. */
	ancestors?: string[];
	showHidden?: boolean;
}

export const SessionViewContext = createContext<SessionViewContextValue>({
	sessionId: "",
	childrenByToolCall: new Map(),
});

export function useSessionView(): SessionViewContextValue {
	return useContext(SessionViewContext);
}

/**
 * Optional components that later views plug into the session timeline without changing it,
 * e.g. the "what the model saw" panel and inline subagent nesting.
 */
export interface SessionSlots {
	/** Rendered beside each model call's meta line; `entry.requestId` names the captured request. */
	ModelCallExtra?: ComponentType<{ sessionId: string; entry: Entry }>;
	/** Rendered inside an Agent card when its child session is known. */
	AgentChild?: ComponentType<{ child: ChildSession; toolCallId: string }>;
}

export const SessionSlotsContext = createContext<SessionSlots>({});

export function useSessionSlots(): SessionSlots {
	return useContext(SessionSlotsContext);
}
