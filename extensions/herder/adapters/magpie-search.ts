import { MAGPIE_SEARCH_TOOLS } from "../../shared/magpie-search.ts";
import { FFF_TOOL_NAMES } from "./fff-search.ts";

export { MAGPIE_SEARCH_SERVER, MAGPIE_SEARCH_TOOLS, isHttpUrlWithoutCredentials, createMagpieSearchExtension } from "../../shared/magpie-search.ts";
export const SEARCHER_TOOLS = [...MAGPIE_SEARCH_TOOLS, "find", "grep", ...FFF_TOOL_NAMES] as const;
