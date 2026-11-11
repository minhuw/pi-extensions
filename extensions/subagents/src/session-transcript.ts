/**
 * session-transcript.ts — Read-only conversation access for records whose live
 * `AgentSession` was torn down upon completion.
 */

import { existsSync } from "node:fs";
import {
  type AgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  SessionManager,
  type ToolDefinition,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { getAgentConversation } from "./agent-runner.js";
import { extractText } from "./context.js";
import type { AgentRecord } from "./types.js";

export type AgentMessage = AgentSession["messages"][number];
export type RecordSessionSource = Pick<AgentRecord, "session" | "sessionFile">;

/** Format `messages` identically to `getAgentConversation(session)`. */
export function formatConversationMessages(messages: readonly AgentMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${(c as any).name ?? (c as any).toolName ?? "unknown"}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}

/** Whether `record` has a live session or a persisted session file on disk. */
export function hasRecordConversation(record: RecordSessionSource): boolean {
  return Boolean(record.session || (record.sessionFile && existsSync(record.sessionFile)));
}

/** Read a record's messages from its live session or on-demand from `sessionFile`. */
export function getRecordMessages(record: RecordSessionSource): AgentMessage[] | undefined {
  if (record.session) {
    return Array.isArray(record.session.messages) ? record.session.messages : undefined;
  }
  if (!record.sessionFile || !existsSync(record.sessionFile)) return undefined;
  try {
    return SessionManager.open(record.sessionFile).buildSessionContext().messages;
  } catch {
    return undefined;
  }
}

/** Format a record's conversation from its live session or on-demand from `sessionFile`. */
export function getRecordConversation(record: RecordSessionSource): string | undefined {
  if (record.session) {
    return Array.isArray(record.session.messages) ? getAgentConversation(record.session) : undefined;
  }
  const messages = getRecordMessages(record);
  return messages ? formatConversationMessages(messages) : undefined;
}

/**
 * Return `record.session` when live, or a lightweight read-only `AgentSession`
 * view backed by `SessionManager.open(record.sessionFile)` for `ConversationViewer`.
 */
export function openViewerSession(record: RecordSessionSource): AgentSession | undefined {
  if (record.session) return record.session;
  if (!record.sessionFile || !existsSync(record.sessionFile)) return undefined;
  try {
    const sessionManager = SessionManager.open(record.sessionFile);
    const messages = sessionManager.buildSessionContext().messages;
    const cwd = sessionManager.getCwd() || process.cwd();
    let builtinTools: Record<string, ToolDefinition<any, any, any>> | undefined;
    const getToolDefinition = (name: string): ToolDefinition<any, any, any> | undefined => {
      if (!builtinTools) {
        builtinTools = {
          bash: createBashToolDefinition(cwd),
          edit: createEditToolDefinition(cwd),
          find: createFindToolDefinition(cwd),
          grep: createGrepToolDefinition(cwd),
          ls: createLsToolDefinition(cwd),
          powershell: createPowerShellToolDefinition(cwd),
          read: createReadToolDefinition(cwd),
          write: createWriteToolDefinition(cwd),
        };
      }
      return builtinTools[name];
    };
    return {
      get messages() {
        return record.session ? record.session.messages : messages;
      },
      subscribe: () => () => {},
      sessionManager,
      getToolDefinition,
      extensionRunner: {
        resolveToolRenderers: (_name: string, base: () => ToolRenderers | undefined) => base(),
      },
    } as unknown as AgentSession;
  } catch {
    return undefined;
  }
}
