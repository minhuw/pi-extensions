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

/** Every key the standard link carries; `linkData` may not reuse any of them. */
export const SESSION_LINK_STANDARD_FIELDS: readonly string[] = [
  "kind", "parentSessionId", "parentSessionFile", "parentToolCallId", "agentId",
  "parentAgentId", "workflowId", "agentType", "description",
];

/** Largest accepted `linkData`, measured as UTF-8 JSON. */
export const LINK_DATA_MAX_BYTES = 8 * 1024;

/**
 * The link entry's data with unknown fields omitted rather than written as
 * undefined, plus a spawner's extra keys (`linkData`, already validated).
 */
export function buildSubagentSessionLink(
  fields: Omit<SubagentSessionLink, "kind">,
  extra?: Record<string, unknown>,
): SubagentSessionLink & Record<string, unknown> {
  const link: SubagentSessionLink & Record<string, unknown> = { kind: "subagent" };
  for (const [key, value] of Object.entries(fields) as [keyof typeof fields, string | undefined][]) {
    if (value !== undefined) link[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (!SESSION_LINK_STANDARD_FIELDS.includes(key)) link[key] = value;
    }
  }
  return link;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Throws naming the first value JSON cannot carry unchanged. */
function assertJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`linkData is not JSON-serializable: ${path} is ${value}`);
    return;
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    if (ancestors.has(value)) throw new Error(`linkData is not JSON-serializable: ${path} is a circular reference`);
    ancestors.add(value);
    if (Array.isArray(value)) value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, ancestors));
    else for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, ancestors);
    ancestors.delete(value);
    return;
  }
  const kind = value === undefined ? "undefined"
    : typeof value === "object" ? `a ${(value as object).constructor?.name ?? "non-plain"} object`
    : `a ${typeof value}`;
  throw new Error(`linkData is not JSON-serializable: ${path} is ${kind}`);
}

/**
 * Validate a spawner's `linkData`: a plain object of JSON values, at most
 * `LINK_DATA_MAX_BYTES` as JSON, with no key that collides with a standard link
 * field. Returns a JSON round-tripped copy, so later mutation by the caller
 * cannot change what is written. Throws an Error with a caller-facing message.
 */
export function validateLinkData(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("linkData must be a plain object");
  for (const key of Object.keys(value)) {
    if (SESSION_LINK_STANDARD_FIELDS.includes(key)) {
      throw new Error(`linkData key "${key}" collides with a standard session-link field`);
    }
  }
  assertJsonValue(value, "linkData", new Set());
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > LINK_DATA_MAX_BYTES) {
    throw new Error(`linkData is too large: ${bytes} bytes as JSON (limit ${LINK_DATA_MAX_BYTES})`);
  }
  return JSON.parse(json) as Record<string, unknown>;
}
