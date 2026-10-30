import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...props }: IconProps & { children: ReactNode }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.4}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...props}
		>
			{children}
		</svg>
	);
}

export const Icons = {
	settings: (p: IconProps) => (
		<Svg {...p}>
			<path d="M2 4h12M2 8h12M2 12h12" />
			<circle cx="5" cy="4" r="1.5" fill="var(--color-page)" />
			<circle cx="11" cy="8" r="1.5" fill="var(--color-page)" />
			<circle cx="7" cy="12" r="1.5" fill="var(--color-page)" />
		</Svg>
	),
	sessions: (p: IconProps) => (
		<Svg {...p}>
			<path d="M3 3.5h10M3 8h10M3 12.5h6" />
		</Svg>
	),
	herder: (p: IconProps) => (
		<Svg {...p}>
			<circle cx="4" cy="4" r="1.6" />
			<circle cx="12" cy="4" r="1.6" />
			<circle cx="8" cy="12" r="1.6" />
			<path d="M5.2 5.2 7 10.6M10.8 5.2 9 10.6" />
		</Svg>
	),
	search: (p: IconProps) => (
		<Svg {...p}>
			<circle cx="7" cy="7" r="4.2" />
			<path d="m10.2 10.2 3.3 3.3" />
		</Svg>
	),
	device: (p: IconProps) => (
		<Svg {...p}>
			<rect x="2" y="3" width="12" height="8" rx="1.2" />
			<path d="M6 13.5h4M8 11v2.5" />
		</Svg>
	),
	key: (p: IconProps) => (
		<Svg {...p}>
			<circle cx="5.5" cy="10.5" r="3" />
			<path d="m7.6 8.4 5.9-5.9M11.5 4.5l1.5 1.5M9.8 6.2l1.3 1.3" />
		</Svg>
	),
	folder: (p: IconProps) => (
		<Svg {...p}>
			<path d="M2 4.5c0-.6.4-1 1-1h3l1.4 1.5H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
		</Svg>
	),
	path: (p: IconProps) => (
		<Svg {...p}>
			<path d="M5.5 13 10.5 3" />
		</Svg>
	),
	clock: (p: IconProps) => (
		<Svg {...p}>
			<circle cx="8" cy="8" r="5.6" />
			<path d="M8 5v3.2l2 1.3" />
		</Svg>
	),
	calendar: (p: IconProps) => (
		<Svg {...p}>
			<rect x="2.5" y="3.5" width="11" height="10" rx="1.2" />
			<path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
		</Svg>
	),
	tokens: (p: IconProps) => (
		<Svg {...p}>
			<path d="M3 4.5h10M3 8h10M3 11.5h10" strokeDasharray="2 1.6" />
		</Svg>
	),
	cost: (p: IconProps) => (
		<Svg {...p}>
			<path d="M10.5 5.2C10 4.4 9.1 4 8 4c-1.5 0-2.5.8-2.5 1.9 0 2.6 5 1.4 5 4.1 0 1.1-1 2-2.5 2-1.2 0-2.1-.5-2.6-1.3M8 2.5V4M8 12v1.5" />
		</Svg>
	),
	// A stack of coins, for amounts already written with a currency sign.
	coins: (p: IconProps) => (
		<Svg {...p}>
			<ellipse cx="8" cy="4.6" rx="4.6" ry="1.9" />
			<path d="M3.4 4.6v3.3c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9V4.6M3.4 7.9v3.3c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9V7.9" />
		</Svg>
	),
	model: (p: IconProps) => (
		<Svg {...p}>
			<rect x="4" y="4" width="8" height="8" rx="1.2" />
			<path d="M6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2" />
		</Svg>
	),
	parent: (p: IconProps) => (
		<Svg {...p}>
			<path d="M8 13V5M4.5 8.5 8 5l3.5 3.5M3 2.5h10" />
		</Svg>
	),
	children: (p: IconProps) => (
		<Svg {...p}>
			<path d="M4 2.5v8c0 .8.7 1.5 1.5 1.5H12M9.5 9.5 12 12l-2.5 2.5" />
		</Svg>
	),
	sun: (p: IconProps) => (
		<Svg {...p}>
			<circle cx="8" cy="8" r="2.8" />
			<path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
		</Svg>
	),
	moon: (p: IconProps) => (
		<Svg {...p}>
			<path d="M13 9.6A5.4 5.4 0 0 1 6.4 3 5.4 5.4 0 1 0 13 9.6z" />
		</Svg>
	),
	sidebar: (p: IconProps) => (
		<Svg {...p}>
			<rect x="2" y="2.5" width="12" height="11" rx="1.5" />
			<path d="M6 2.5v11" />
		</Svg>
	),
	terminal: (p: IconProps) => (
		<Svg {...p}>
			<path d="m3.5 5 3 3-3 3M8.5 11.5h4" />
		</Svg>
	),
	file: (p: IconProps) => (
		<Svg {...p}>
			<path d="M4 2h5l3 3v9H4z" />
			<path d="M9 2v3h3" />
		</Svg>
	),
	pencil: (p: IconProps) => (
		<Svg {...p}>
			<path d="m10.5 2.5 3 3-8 8H2.5v-3z" />
		</Svg>
	),
	globe: (p: IconProps) => (
		<Svg {...p}>
			<circle cx="8" cy="8" r="5.8" />
			<path d="M2.2 8h11.6M8 2.2c1.6 1.6 2.3 3.6 2.3 5.8S9.6 12.2 8 13.8C6.4 12.2 5.7 10.2 5.7 8S6.4 3.8 8 2.2z" />
		</Svg>
	),
	agent: (p: IconProps) => (
		<Svg {...p}>
			<circle cx="8" cy="5.5" r="2.5" />
			<path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" />
		</Svg>
	),
	code: (p: IconProps) => (
		<Svg {...p}>
			<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
		</Svg>
	),
	tool: (p: IconProps) => (
		<Svg {...p}>
			<path d="M10 2.5a3.2 3.2 0 0 0-3 4.3l-4.3 4.3a1.3 1.3 0 0 0 1.9 1.9L9 8.7a3.2 3.2 0 0 0 4.3-3l-1.8 1.8-1.9-.5-.5-1.9z" />
		</Svg>
	),
	alert: (p: IconProps) => (
		<Svg {...p}>
			<path d="M8 2 14.5 13.5h-13z" />
			<path d="M8 6.5v3M8 11.5v.01" />
		</Svg>
	),
	info: (p: IconProps) => (
		<Svg {...p}>
			<circle cx="8" cy="8" r="5.8" />
			<path d="M8 7.2v3.6M8 5v.01" />
		</Svg>
	),
	compress: (p: IconProps) => (
		<Svg {...p}>
			<path d="M3 6h10M3 10h10M8 1.5v3l-1.5-1.5M8 4.5l1.5-1.5M8 14.5v-3l-1.5 1.5M8 11.5l1.5 1.5" />
		</Svg>
	),
	branch: (p: IconProps) => (
		<Svg {...p}>
			<circle cx="4.5" cy="3.5" r="1.5" />
			<circle cx="4.5" cy="12.5" r="1.5" />
			<circle cx="11.5" cy="6" r="1.5" />
			<path d="M4.5 5v6M11.5 7.5c0 2-2 2.5-7 3.5" />
		</Svg>
	),
	tag: (p: IconProps) => (
		<Svg {...p}>
			<path d="M2.5 2.5h5l6 6-5 5-6-6z" />
			<circle cx="5.3" cy="5.3" r=".8" />
		</Svg>
	),
	external: (p: IconProps) => (
		<Svg {...p}>
			<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3.5c0 .3-.2.5-.5.5H3c-.3 0-.5-.2-.5-.5V5c0-.3.2-.5.5-.5h3.5" />
		</Svg>
	),
	download: (p: IconProps) => (
		<Svg {...p}>
			<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
		</Svg>
	),
	eye: (p: IconProps) => (
		<Svg {...p}>
			<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
			<circle cx="8" cy="8" r="2" />
		</Svg>
	),
	user: (p: IconProps) => (
		<Svg {...p}>
			<circle cx="8" cy="5.5" r="2.5" />
			<path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" />
		</Svg>
	),
	pulse: (p: IconProps) => (
		<Svg {...p}>
			<path d="M1.5 8.5h3l1.8-4.5 3 8 1.9-5 .8 1.5h2.5" />
		</Svg>
	),
	message: (p: IconProps) => (
		<Svg {...p}>
			<path d="M2.5 4c0-.6.4-1 1-1h9c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H7l-3 2.5V11h-.5c-.6 0-1-.4-1-1z" />
		</Svg>
	),
	copy: (p: IconProps) => (
		<Svg {...p}>
			<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
			<path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
		</Svg>
	),
	check: (p: IconProps) => (
		<Svg {...p}>
			<path d="m3 8.5 3.2 3L13 4.5" />
		</Svg>
	),
	sparkle: (p: IconProps) => (
		<Svg {...p}>
			<path d="M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8l4.8-1.4z" />
		</Svg>
	),
};

export type IconName = keyof typeof Icons;

export function Icon({ name, ...props }: IconProps & { name: IconName }) {
	const Component = Icons[name];
	return <Component {...props} />;
}

/**
 * The pika logo, inlined so it renders under any base path. The source of truth is
 * services/pika/resource/pika-icon.svg; keep these shapes in step with it.
 */
export function PikaLogo({ size = 20, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 1254 1254" aria-hidden="true" data-pika-logo="" {...props}>
			<path
				fill="#F9856D"
				d="M397 449 323 376C273 327 271 269 303 222 331 180 376 154 426 154 471 154 508 173 540 205L688 361C580 362 480 397 397 449Z"
			/>
			<path
				fill="#4D90C2"
				d="M596 261C601 218 630 187 667 178 730 160 783 190 817 245 844 288 857 338 854 389 968 427 1044 502 1044 601 1044 724 943 823 793 823H474V1044Q474 1110 409 1110H278Q212 1110 212 1044V779C212 648 272 538 397 449 480 397 580 362 688 361Z"
			/>
			<path fill="#FCC64D" d="M474 758H604C708 758 789 840 789 940V983Q789 1047 725 1047H474Z" />
			<circle fill="#FFFFFF" cx="847" cy="570" r="54" />
		</svg>
	);
}
