import { describe, expect, it } from "vitest";
import { ACTIONS, buildKeymap, chordId, parseChord, RESERVED, terminalSafe } from "../src/nodes/keys";
import { PANE_ACTIONS } from "../src/nodes/panes/keys";

describe.each([
    ["macOS", true],
    ["elsewhere", false],
] as const)("pane chords %s", (_, mac) => {
    const chordsOf = (spec: { mac: readonly string[]; other: readonly string[] }) => (mac ? spec.mac : spec.other);

    it("parse, and are ones the terminal lets the page have", () => {
        for (const spec of PANE_ACTIONS) {
            for (const text of chordsOf(spec)) {
                const chord = parseChord(text);
                expect(chord, `${spec.id}: ${text}`).toBeDefined();
                expect(terminalSafe(chord!, mac), `${spec.id}: ${text}`).toBe(true);
            }
        }
    });

    it("are not the browser's, and clash with no page action or each other", () => {
        const reserved = new Set((mac ? RESERVED.mac : RESERVED.other).map((text) => chordId(parseChord(text)!)));
        const keymap = buildKeymap(undefined, mac);
        const taken = new Set([...keymap.bindings.values()].flat().map(chordId));
        expect(ACTIONS.length).toBeGreaterThan(0);
        const seen = new Set<string>();
        for (const spec of PANE_ACTIONS) {
            for (const text of chordsOf(spec)) {
                const id = chordId(parseChord(text)!);
                expect(reserved.has(id), `${spec.id}: ${text} is reserved`).toBe(false);
                expect(taken.has(id), `${spec.id}: ${text} is a page action's`).toBe(false);
                expect(seen.has(id), `${spec.id}: ${text} twice`).toBe(false);
                seen.add(id);
            }
        }
    });
});
