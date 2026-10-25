import type { RoleDefinition } from "../types.ts";

export interface RoleSources { builtinDir?: string; overrideDir?: string }

export function parseRole(text: string, source?: string): RoleDefinition { throw new Error("not implemented"); }
/** Built-in roles overridden by `~/.pi/agent/herder/agents/<role>.md`. */
export function loadRoles(sources?: RoleSources): Map<string, RoleDefinition> { throw new Error("not implemented"); }
export function loadRole(name: string, sources?: RoleSources): RoleDefinition { throw new Error("not implemented"); }
