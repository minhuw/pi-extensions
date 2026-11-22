/** Tool result lines, shared with the Pi relay extension (`extensions/pika/relay/protocol.ts`), plus Codex-specific rejection wording. */
import { BASE_REJECTIONS } from "../../../extensions/pika/relay/protocol.ts";

export { memberLabel, preview, roomLine, roomMessageLine, sendResult, sessionLine, unmatchedOf } from "../../../extensions/pika/relay/protocol.ts";

export const REJECTIONS: Record<string, string> = {
    ...BASE_REJECTIONS,
    // Codex has no /relay commands: a thread is added to rooms in the pika web UI.
    unknown_room: "no such chatroom; your user creates rooms in the pika web UI",
    not_member: "this session is not a member of that room; only your user can add it, in the pika web UI",
};
