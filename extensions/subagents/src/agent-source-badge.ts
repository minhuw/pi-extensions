/** Source badges, their legend, and the highlighted agent's description in `/agents`. */

import type { AgentConfig } from "./types.js";

/** Three-cell badge column; built-in defaults are unmarked. */
export function sourceIndicator(cfg: AgentConfig | undefined): string {
  const disabled = cfg?.enabled === false;
  if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
  if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
  if (cfg?.source === "package") return disabled ? "✕▪ " : "▪  ";
  if (disabled) return "✕  ";
  return "   ";
}

/** Explain only badges present in the roster; defaults have no source badge. */
export function sourceLegend(cfgs: readonly (AgentConfig | undefined)[]): string {
  const parts: string[] = [];
  if (cfgs.some(c => c?.source === "project")) parts.push("• = project");
  if (cfgs.some(c => c?.source === "global")) parts.push("◦ = global");
  if (cfgs.some(c => c?.source === "package")) parts.push("▪ = package");
  if (cfgs.some(c => c?.enabled === false)) parts.push("✕ = disabled");
  return parts.join("  ");
}

/** Keep package provenance visible before long descriptions, including disabled rows. */
export function rowDescription(
  name: string,
  cfg: AgentConfig | undefined,
  packageName?: string,
): string {
  const base = cfg?.enabled === false ? "(disabled)" : (cfg?.description ?? name);
  return packageName ? `${packageName} · ${base}` : base;
}
