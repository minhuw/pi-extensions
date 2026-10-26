/**
 * child-session-hooks.ts — the process-global seam other extensions use to load
 * into every child session this extension creates, and the link entry that
 * ties a child session back to its spawner.
 *
 * Extensions never import each other: whoever needs the Set first creates it
 * under a `Symbol.for` key, and members are plain `{ name, extensionFactory }`.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const CHILD_SESSION_HOOKS_KEY = Symbol.for("pi-extensions.child-session-hooks");

export interface ChildSessionHook {
  name: string;
  extensionFactory: ExtensionFactory;
}

/** Registered hooks, in insertion order. Malformed members are skipped. */
export function getChildSessionHooks(): ChildSessionHook[] {
  const hooks = (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS_KEY];
  if (!(hooks instanceof Set)) return [];
  return [...hooks].filter(
    (hook): hook is ChildSessionHook =>
      typeof hook === "object" && hook !== null
      && typeof (hook as ChildSessionHook).name === "string"
      && typeof (hook as ChildSessionHook).extensionFactory === "function",
  );
}

/** Hooks as named loader factories, appended last to a child's `extensionFactories`. */
export function childSessionHookFactories(hooks: ChildSessionHook[]): { name: string; factory: ExtensionFactory }[] {
  return hooks.map((hook) => ({ name: hook.name, factory: hook.extensionFactory }));
}

export const SESSION_LINK_CUSTOM_TYPE = "pi-extensions.session-link";

export interface SubagentSessionLink {
  kind: "subagent";
  parentSessionId?: string;
  parentSessionFile?: string;
  parentToolCallId?: string;
  agentId?: string;
  parentAgentId?: string;
  workflowId?: string;
  agentType?: string;
  description?: string;
}

/** The link entry's data with unknown fields omitted rather than written as undefined. */
export function buildSubagentSessionLink(fields: Omit<SubagentSessionLink, "kind">): SubagentSessionLink {
  const link: SubagentSessionLink = { kind: "subagent" };
  for (const [key, value] of Object.entries(fields) as [keyof typeof fields, string | undefined][]) {
    if (value !== undefined) link[key] = value;
  }
  return link;
}
