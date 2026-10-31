import { FAMILIES, FAMILY_LABELS } from "./kinds";
import { KindBullet } from "./parts";

const KEYS: [string, string][] = [
	["Click", "inspect a row or bar"],
	["Drag", "filter the timeline by time"],
	["⌘/Ctrl + scroll", "zoom the timeline"],
	["Shift + scroll", "pan"],
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
				className="inline-flex size-6 items-center justify-center rounded-full border border-line text-[12px] leading-none font-medium text-muted transition-colors duration-150 hover:border-ink hover:text-ink focus-visible:border-ink focus-visible:text-ink"
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
				<div className="w-[330px] rounded-sm border border-ink bg-page px-3.5 py-3 text-[13px] shadow-[0_8px_24px_rgba(0,0,0,0.14)]">
					<dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
						{KEYS.map(([key, what]) => (
							<div key={key} className="contents">
								<dt>
									<kbd className="mono rounded-sm border border-line px-1.5 py-px text-[11px] text-ink">{key}</kbd>
								</dt>
								<dd className="text-muted">{what}</dd>
							</div>
						))}
					</dl>
					<div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-2.5">
						{FAMILIES.map((family) => (
							<span key={family} className="flex items-center gap-2 text-muted">
								<KindBullet family={family} size={14} />
								{FAMILY_LABELS[family]}
							</span>
						))}
						<span className="flex items-center gap-2 text-muted">
							<span aria-hidden="true" className="size-3.5 rounded-full border-2 border-k-error" />
							Error
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}
