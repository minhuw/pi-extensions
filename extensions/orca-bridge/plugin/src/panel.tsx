import {
	atom, Badge, Button, EmptyState, Heading, IconButton, List, ListItem, plugin, Progress,
	read, RelativeTime, Row, Select, Separator, set, Spinner, Stack, Text, type PanelContext, type Tone,
} from "orca";
import type {} from "./api.ts";
import { sessionState, summarize, type ActivityView, type SessionView } from "./protocol.ts";

const view = atom<ActivityView | null>(null);
const error = atom(false);
const loading = atom(false);
const selected = atom("");
let reload = async (): Promise<void> => {};

export function setup(ctx: PanelContext): () => void {
	let flight: Promise<void> | undefined;
	let again = false;
	let lastReceived = 0;
	reload = () => {
		if (ctx.signal.aborted) return Promise.resolve();
		if (flight) { again = true; return flight; }
		set(loading, true);
		flight = plugin.request("activity.list", {}, { signal: ctx.signal, timeoutMs: 5_000 })
			.then(result => {
				if (ctx.signal.aborted) return;
				set(view, result); set(error, false); lastReceived = Date.now();
			})
			.catch(() => { if (!ctx.signal.aborted) set(error, true); })
			.finally(() => {
				flight = undefined;
				if (ctx.signal.aborted) return;
				set(loading, false);
				if (again) { again = false; void reload(); }
			});
		return flight;
	};
	ctx.subscriptions.push(plugin.on("activity.changed", () => { void reload(); }));
	// Revalidate if a worker restart/crash interrupted pushes; normal updates are event-driven.
	const timer = setInterval(() => { if (Date.now() - lastReceived >= 15_000) void reload(); }, 5_000);
	void reload();
	return () => { clearInterval(timer); reload = async () => {}; };
}

const tone = (state: ReturnType<typeof sessionState>): Tone => state === "waiting" || state === "disconnected" ? "warning" : state === "working" ? "accent" : "neutral";
const stateLabel = { working: "Working", waiting: "Waiting", idle: "Idle", disconnected: "Disconnected" };

function Session({ session }: { session: SessionView }) {
	const state = sessionState(session);
	return <Stack gap="md">
		<Stack gap="xs">
			<Row justify="between" wrap>
				<Heading level={2}>{session.title}</Heading>
				<Badge tone={tone(state)}>{stateLabel[state]}</Badge>
			</Row>
			<Text muted size="xs">{session.cwd}</Text>
			{session.model ? <Text muted size="xs">{session.model}</Text> : null}
		</Stack>
		{!session.online ? <Stack gap="xs">
			<Text tone="warning">Connection lost. The activities below are the last reported state.</Text>
			<Text muted size="xs">Last seen <RelativeTime at={session.updatedAt} />. Check the terminal or run /orca-status.</Text>
		</Stack> : <Row justify="between" wrap>
			<Text weight="medium">Main agent</Text>
			<Text tone={session.waiting ? "warning" : "neutral"}>
				{session.waiting ? "Waiting for input" : session.parent === "running" ? "Running" : "Idle"}
				{session.parent === "running" && !session.waiting ? <> · <RelativeTime at={session.startedAt} format="duration" /></> : null}
			</Text>
		</Row>}
		<Separator />
		<Stack gap="sm">
			<Heading level={3}>Background activities · {session.activityCount}</Heading>
			{session.activities.length ? <List label="Background activities">
				{session.activities.map(activity => <ListItem key={`${activity.source}:${activity.id}`}>
					<Stack gap="xs">
						<Text weight="medium">{activity.label}</Text>
						<Row gap="sm" wrap>
							<Text muted size="xs">{activity.source}</Text>
							<Text size="xs" tone={session.online && activity.state === "waiting" ? "warning" : "neutral"}>
								{!session.online ? "Last reported" : activity.state === "waiting" ? "Waiting" : "Running"}
							</Text>
							{session.online ? <RelativeTime at={activity.startedAt} format="duration" muted /> : null}
						</Row>
						{activity.model ? <Text muted size="xs">{activity.model}</Text> : null}
						{activity.progress ? <Progress label={`${activity.progress.completed} of ${activity.progress.total} agents finished`} value={100 * activity.progress.completed / activity.progress.total} /> : null}
					</Stack>
				</ListItem>)}
			</List> : <Text muted>No background activities.</Text>}
			{session.activityCount > session.activities.length ? <Text muted size="xs">{session.activityCount - session.activities.length} additional activities are included in the total.</Text> : null}
		</Stack>
	</Stack>;
}

export default function Panel() {
	const current = read(view), failed = read(error) || current?.unavailable;
	const counts = current ? summarize(current) : undefined;
	const session = current?.sessions.find(item => item.paneKey === read(selected)) ?? current?.sessions[0];
	return <Stack gap="md">
		<Row justify="between">
			<Heading>Activity</Heading>
			<IconButton icon="refresh" label="Refresh activity" variant="ghost" disabled={read(loading)} onPress={() => void reload()} />
		</Row>
		<Text muted size="sm">Local Pi terminal sessions</Text>
		{failed ? <EmptyState title="Activity is unavailable" description="Check that the Pi Activity plugin is enabled, then retry." icon="warning">
			<Button onPress={() => void reload()} disabled={read(loading)}>Retry</Button>
		</EmptyState> : !current ? <Spinner label="Loading Pi activity" /> : !session ?
			<EmptyState title="No Pi sessions yet" description="Open Pi in an Orca terminal with orca-bridge enabled. Sessions appear automatically within a few seconds." icon="terminal" /> : <Stack gap="md">
				<Text>{counts!.working} working · {counts!.waiting} waiting · {counts!.activities} background activities</Text>
				{current.sessions.length > 1 ? <Select label="Session" value={session.paneKey} options={current.sessions.map(item => ({
					value: item.paneKey, label: `${item.title} · ${stateLabel[sessionState(item)]} · ${item.sessionId.slice(0, 8)}`,
				}))} onChange={value => set(selected, value)} /> : null}
				{current.truncated ? <Text tone="warning" size="xs">Showing a limited set of sessions. Waiting and active sessions appear first.</Text> : null}
				<Session session={session} />
			</Stack>}
	</Stack>;
}
