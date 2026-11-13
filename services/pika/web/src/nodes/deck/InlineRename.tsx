import { useEffect, useRef, useState } from "react";
import { cn } from "../../components/ui-shadcn/utils";

/**
 * A name edited in place: Enter or leaving the field saves (blank text clears the name), Escape gives up. The field
 * stops the rail's own keys while it has focus.
 */
export function InlineRename({ initial, label, onCommit, onCancel, className }: { initial: string; label: string; onCommit: (name: string | null) => void; onCancel: () => void; className?: string }) {
	const [value, setValue] = useState(initial);
	const field = useRef<HTMLInputElement>(null);
	const done = useRef(false);
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);
	const finish = (commit: boolean) => {
		if (done.current) return;
		done.current = true;
		if (!commit) return onCancel();
		const trimmed = value.trim();
		if (trimmed === initial.trim()) return onCancel();
		onCommit(trimmed || null);
	};
	return (
		<input
			ref={field}
			className={cn("h-6 min-w-0 flex-1 rounded-[2px] border border-dk-accent bg-dk-ground px-1 text-[13px] text-dk-ink outline-none", className)}
			value={value}
			aria-label={label}
			maxLength={120}
			spellCheck={false}
			onChange={(event) => setValue(event.target.value)}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Enter") {
					event.preventDefault();
					finish(true);
				} else if (event.key === "Escape") {
					event.preventDefault();
					finish(false);
				}
			}}
			onBlur={() => finish(true)}
			onClick={(event) => event.stopPropagation()}
			data-inline-rename=""
		/>
	);
}
