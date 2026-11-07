export interface DocHeading {
	id: string;
	title: string;
	depth: number;
}

export interface DocPage {
	slug: string;
	title: string;
	section: string;
	description: string;
	/** Repository-relative Markdown path, retained for source links and relative link resolution. */
	source: string;
	markdown: string;
	headings: DocHeading[];
	searchText: string;
}

export interface DocCommand {
	command: string;
	extension: string;
	description: string;
	/** Documentation slug, optionally followed by a section fragment. */
	slug: string;
}

export interface DocGroup {
	title: string;
	items: { title: string; slug: string }[];
}

export interface DocsData {
	pages: DocPage[];
	commands: DocCommand[];
	groups: DocGroup[];
}
