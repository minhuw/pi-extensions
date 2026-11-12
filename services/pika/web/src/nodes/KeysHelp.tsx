import { useRef, useState, useSyncExternalStore } from "react";
import { Callout } from "../components/ui";
import { Button } from "../components/ui-shadcn/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../components/ui-shadcn/dialog";
import { ACTIONS, BUILT_IN, formatChord, KEYS_EXAMPLE, KEYS_KEY, keymapFrom, keySettings, saveKeySettings, subscribeKeys, terminalSafe, type ActionSpec, type Keymap } from "./keys";

const GROUPS: readonly ActionSpec["group"][] = ["General", "Agents", "Panes", "Tabs", "Terminal", "Files", "Diff"];

function useKeySettings() {
	return useSyncExternalStore(subscribeKeys, keySettings);
}

/** Where an action's chord works, when not everywhere. */
function where(spec: ActionSpec, keymap: Keymap, chordIndex: number): string | undefined {
	if (spec.only === "terminal") return "in the terminal";
	if (spec.only === "diff") return "in a diff";
	const chord = keymap.bindings.get(spec.id)?.[chordIndex];
	if (!spec.terminal || (chord && !terminalSafe(chord, keymap.mac))) return "not in the terminal";
	return undefined;
}

/**
 * Every shortcut in Deck, from the registry, with what the user's settings changed or could not apply; the
 * settings are plain JSON in `localStorage`, edited here in a text box.
 */
export function KeysHelp({ onClose }: { onClose: () => void }) {
	const { text, keymap } = useKeySettings();
	const [draft, setDraft] = useState<string | null>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const editing = draft !== null;
	const preview = editing ? keymapFrom(draft, keymap.mac) : keymap;

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent initialFocus={closeRef} className="flex max-h-[min(720px,calc(100vh-48px))] max-w-[640px] flex-col p-0" data-keys-help="">
				<div className="flex shrink-0 items-center gap-3 border-b border-dk-line px-5 py-3">
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogClose ref={closeRef} render={<Button variant="ghost" className="ml-auto" />}>
						Close
					</DialogClose>
				</div>
				<div className="min-h-0 overflow-y-auto px-5 pt-2 pb-4 text-[13px]">
					{preview.problems.length > 0 && (
						<div className="mt-2" data-keys-problems={preview.problems.length}>
							<Callout tone="red" title={editing ? "These settings have problems" : "Some key settings were not applied"}>
								<ul className="list-disc pl-4">
									{preview.problems.map((problem, index) => (
										<li key={index}>{problem.message}</li>
									))}
								</ul>
							</Callout>
						</div>
					)}
					{GROUPS.map((group) => {
						const specs = ACTIONS.filter((spec) => spec.group === group);
						return (
							<section key={group} className="mt-3">
								<h3 className="text-[12px] font-semibold text-dk-ink-2">{group}</h3>
								<table className="mt-1 w-full">
									<tbody>
										{specs.map((spec) => {
											const chords = preview.bindings.get(spec.id) ?? [];
											return (
												<tr key={spec.id} className="border-b border-line last:border-0" data-key-action={spec.id}>
													<td className="py-1.5 pr-3 align-top">
														{spec.label}
														{preview.custom.has(spec.id) && <span className="ml-1.5 text-[11.5px] text-muted">(yours)</span>}
													</td>
													<td className="py-1.5 text-right align-top whitespace-nowrap">
														{chords.length === 0 ? (
															<span className="text-muted">None</span>
														) : (
															chords.map((chord, index) => {
																const note = where(spec, preview, index);
																return (
																	<span key={index} className="ml-2 inline-flex items-center gap-1">
																		<kbd className="rounded-sm border border-line bg-code px-1.5 py-0.5 font-mono text-[12px]">{formatChord(chord, preview.mac)}</kbd>
																		{note && <span className="text-[11.5px] text-muted">{note}</span>}
																	</span>
																);
															})
														)}
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</section>
						);
					})}
					<section className="mt-3">
						<h3 className="text-[12px] font-semibold text-dk-ink-2">Built in</h3>
						<table className="mt-1 w-full">
							<tbody>
								{BUILT_IN.map((item) => (
									<tr key={item.label} className="border-b border-line last:border-0">
										<td className="py-1.5 pr-3">{item.label}</td>
										<td className="py-1.5 text-right whitespace-nowrap">
											<kbd className="rounded-sm border border-line bg-code px-1.5 py-0.5 font-mono text-[12px]">{keymap.mac ? item.mac : item.other}</kbd>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
					<p className="mt-3 text-[12.5px] text-muted">
						In the terminal, only {keymap.mac ? "⌘ chords" : "Ctrl+Shift chords"} reach these shortcuts; every other key goes to the shell or pi. The
						browser keeps its own keys, such as {keymap.mac ? "⌘W, ⌘T, ⌘N, and ⌘L" : "Ctrl+W, Ctrl+T, Ctrl+N, and Ctrl+L"}.
					</p>
					<section className="mt-4">
						<h3 className="text-[12px] font-semibold text-dk-ink-2">Your bindings</h3>
						<p className="mt-1 text-[12.5px] text-muted">
							JSON kept in this browser (<code className="code-chip">localStorage["{KEYS_KEY}"]</code>): action names from{" "}
							<code className="code-chip">{ACTIONS.map((spec) => spec.id).join(", ")}</code>, each a chord such as{" "}
							<code className="code-chip">{keymap.mac ? "Cmd+Alt+N" : "Ctrl+Shift+Alt+N"}</code>, a list of them, or [] for none.
						</p>
						{editing ? (
							<>
								<textarea
									className="mt-2 h-40 w-full rounded-sm border border-line bg-page p-2 font-mono text-[12.5px]"
									spellCheck={false}
									aria-label="Key bindings JSON"
									value={draft}
									onChange={(event) => setDraft(event.target.value)}
									data-keys-editor=""
								/>
								<div className="mt-2 flex gap-2">
									<Button
										onClick={() => {
											saveKeySettings(draft);
											setDraft(null);
										}}
										data-keys-save=""
									>
										Save
									</Button>
									<Button variant="outline" onClick={() => setDraft(null)}>
										Cancel
									</Button>
									{text !== null && (
										<Button
											variant="ghost"
											className="ml-auto"
											onClick={() => {
												saveKeySettings(null);
												setDraft(null);
											}}
											data-keys-reset=""
										>
											Back to the defaults
										</Button>
									)}
								</div>
							</>
						) : (
							<Button variant="outline" className="mt-2" onClick={() => setDraft(text ?? KEYS_EXAMPLE)} data-keys-edit="">
								{text === null ? "Rebind keys…" : "Edit your bindings…"}
							</Button>
						)}
					</section>
				</div>
			</DialogContent>
		</Dialog>
	);
}
