/**
 * A text field that offers completions, in shadcn/ui's style (its combobox, `registry/bases/base/ui/combobox.tsx`;
 * MIT, see SHADCN-LICENSE) on Base UI's Autocomplete, which keeps free text: the value is what is typed, and choosing
 * an item fills it in. Deck lists the items inline under the field (Add Project's folders), not in a popup.
 */
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { INPUT } from "./input";
import { cn } from "./utils";

const Autocomplete = AutocompletePrimitive.Root;

function AutocompleteInput({ className, ...props }: AutocompletePrimitive.Input.Props) {
	return <AutocompletePrimitive.Input data-slot="autocomplete-input" className={cn(INPUT, className)} {...props} />;
}

function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
	return (
		<AutocompletePrimitive.List
			data-slot="autocomplete-list"
			className={cn("max-h-[180px] overflow-y-auto rounded-[4px] border border-dk-line py-0.5 font-mono text-[12.5px] empty:hidden", className)}
			{...props}
		/>
	);
}

function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
	return (
		<AutocompletePrimitive.Item
			data-slot="autocomplete-item"
			className={cn("cursor-default truncate px-2 py-0.5 outline-none select-none data-highlighted:bg-dk-menu-hi", className)}
			{...props}
		/>
	);
}

export { Autocomplete, AutocompleteInput, AutocompleteItem, AutocompleteList };
