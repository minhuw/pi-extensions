import { cx } from "../components/ui";
import { FAMILIES, FAMILY_CLASSES, FAMILY_LABELS } from "./kinds";

const KEYS: [string, string][] = [
	["Click", "inspect a row or bar"],
	["Drag", "filter the timeline by time"],
	["↑ ↓", "move"],
	["← →", "fold a turn"],
	["[ ]", "previous / next turn"],
	["Enter", "focus the inspector"],
	["/", "filter"],
	["Esc", "clear range, stop replay"],
	["?", "this help"],
];

/**
 * A `?` in the ledger's toolbar whose popover holds the keyboard shortcuts and the color legend, shown on hover or
 * focus, so neither takes room on the page.
 */
export function LedgerHelp() {
	return (
		<div className="group relative" data-ledger-help="">
			<button
				type="button"
				className="inline-flex size-5 items-center justify-center rounded-full border border-line text-[11px] leading-none text-muted transition-colors duration-150 hover:border-muted hover:text-ink focus-visible:border-accent focus-visible:text-ink focus-visible:outline-none"
				aria-label="Keyboard shortcuts and colors"
				aria-describedby="ledger-help"
			>
				?
			</button>
			{/* The top padding bridges the gap to the button, so the pointer can move into the popover. */}
			<div
				id="ledger-help"
				role="tooltip"
				className="invisible absolute top-full right-0 z-30 pt-1.5 opacity-0 transition-opacity duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
			>
				<div className="w-[300px] rounded-md border border-line bg-page px-3.5 py-3 text-[12.5px] shadow-[0_4px_16px_rgba(15,15,15,0.12)]">
					<dl className="grid grid-cols-[64px_1fr] gap-y-1">
						{KEYS.map(([key, what]) => (
							<div key={key} className="contents">
								<dt>
									<kbd className="mono rounded-[3px] border border-line px-1.5 py-px text-[11px] text-muted">{key}</kbd>
								</dt>
								<dd className="text-muted">{what}</dd>
							</div>
						))}
					</dl>
					<div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-2.5">
						{FAMILIES.map((family) => (
							<span key={family} className="flex items-center gap-2 text-muted">
								<span className={cx("h-2 w-3.5 rounded-[2px] opacity-80", FAMILY_CLASSES[family].bar)} />
								{FAMILY_LABELS[family]}
							</span>
						))}
						<span className="flex items-center gap-2 text-muted">
							<span className="h-2 w-3.5 rounded-[2px] bg-k-error" />
							Error
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}
