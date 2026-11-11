/**
 * completion-outbox.ts — When background completions reach the parent.
 *
 * Claude Code queues each completion and, after every tool batch, hands the
 * model everything that queued up in one go: a busy parent sees what finished
 * during the batch before its next model call, and nothing waits for a sibling.
 * pi's steering queue would split those into one model call each under its
 * default `one-at-a-time` mode, so the outbox holds them and sends ONE message
 * at the boundary instead.
 *
 * - Parent busy: held until `turn_end`, which pi emits after the tool batch and
 *   before it reads the steering queue.
 * - Parent idle: sent after a short hold, so near-simultaneous completions
 *   share a turn and `get_subagent_result` still gets a moment to consume one.
 * - Parent turn aborted (Esc) or failed: held through it — pi clears its own
 *   queues on Esc — and sent once the run has ended, starting a turn. Claude
 *   Code keeps an agent's completion queued through Esc the same way and runs
 *   it as soon as the interrupted turn stops.
 */

import type { NotificationDetails } from "./types.js";

/** How long an idle parent's notification is held before it is sent. */
export const NOTIFICATION_HOLD_MS = 200;

export interface OutboxMessage {
  content: string;
  details: NotificationDetails;
}

/**
 * A notification for one or more executions, built when they finish. Parallel
 * `ids` and `executionIds` identify its members; a missing execution ID uses
 * legacy agent-level identity. Consuming a result removes its matching member,
 * and an empty item is dropped. `build` receives the remaining members.
 */
export interface OutboxItem {
  ids: string[];
  executionIds?: (string | undefined)[];
  build(ids: readonly string[], executionIds: readonly (string | undefined)[]): OutboxMessage;
}

export class CompletionOutbox {
  private items: OutboxItem[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** Delivers one message as a steer that triggers a turn when the parent is idle. */
    private send: (message: OutboxMessage) => void,
    /** Whether the parent has a run in flight, so a `turn_end` is coming. */
    private parentRunning: () => boolean,
  ) {}

  /**
   * Replace a pending duplicate (agent ID and execution ID). Distinct executions
   * coexist; if either entry lacks an execution ID, agent ID alone replaces it.
   * A completion added after a flush remains eligible for redelivery.
   */
  add(item: OutboxItem): void {
    item.ids.forEach((id, index) => {
      const executionId = item.executionIds?.[index];
      this.removeWhere((otherId, otherExecutionId) => otherId === id &&
        (executionId === undefined || otherExecutionId === undefined || executionId === otherExecutionId));
    });
    this.items.push(item);
    if (!this.parentRunning()) this.arm();
  }

  /** The parent finished a turn: its tool batch is done, the next model call is not. */
  onTurnEnd(stopReason: string | undefined): void {
    // An aborted turn ends its run; a failed one may be retried. Either way
    // what is held waits for the next boundary or the run's end — sent now,
    // it would sit in a queue pi is about to clear.
    if (stopReason !== "aborted" && stopReason !== "error") this.flush();
  }

  /** Cancel the consumed execution; a missing ID on either side matches by agent ID. */
  cancel(id: string, executionId?: string): void {
    this.removeWhere((otherId, otherExecutionId) => otherId === id &&
      (executionId === undefined || otherExecutionId === undefined || otherExecutionId === executionId));
  }

  private removeWhere(matches: (id: string, executionId: string | undefined) => boolean): void {
    for (const item of this.items) {
      const keep = item.ids.map((id, i) => !matches(id, item.executionIds?.[i]));
      item.ids = item.ids.filter((_, i) => keep[i]);
      if (item.executionIds) item.executionIds = item.executionIds.filter((_, i) => keep[i]);
    }
    this.items = this.items.filter(item => item.ids.length > 0);
  }

  /**
   * Completions that landed after the run's last `turn_end` would otherwise wait for the next run.
   * Called at `agent_end` and again at `agent_settled`: one can land while the ending run is still open.
   */
  onAgentEnd(): void {
    if (this.items.length > 0) this.arm();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.items = [];
  }

  /** Not reset by later items: the first completion is never pushed back. */
  private arm(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, NOTIFICATION_HOLD_MS);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const items = this.items;
    this.items = [];
    const messages = items.map(item => item.build(item.ids, item.executionIds ?? item.ids.map(() => undefined)));
    if (messages.length === 0) return;
    // A send from a timer can outlive the session it was meant for (pi -p
    // tearing down): pi throws on the stale context, and nothing is left to tell.
    try { this.send(combine(messages)); } catch { /* stale context */ }
  }
}

/** One message stays as it was built; several become one message with every agent's details. */
function combine(messages: OutboxMessage[]): OutboxMessage {
  if (messages.length === 1) return messages[0];
  const [first, ...rest] = messages.flatMap(({ details: { others, ...own } }) => [own, ...(others ?? [])]);
  return {
    content: `${messages.length} background tasks finished.\n\n${messages.map(m => m.content).join("\n\n")}`,
    details: { ...first, others: rest },
  };
}
