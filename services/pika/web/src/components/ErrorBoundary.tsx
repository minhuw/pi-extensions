import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
	/** What failed, for the log: `the trajectory view`, `the timeline`. */
	label: string;
	/** Rendered instead of the children after they threw; `reset` renders them again. */
	fallback: (props: { error: unknown; reset: () => void }) => ReactNode;
	/** A new value renders the children again, as when fresh data may no longer make them throw. */
	resetKey?: unknown;
	children: ReactNode;
}

interface State {
	error: unknown;
	failed: boolean;
	resetKey: unknown;
}

/** Keeps a rendering error in one part of a page from blanking the whole page. */
export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: undefined, failed: false, resetKey: this.props.resetKey };

	static getDerivedStateFromError(error: unknown): Partial<State> {
		return { error, failed: true };
	}

	static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
		if (props.resetKey === state.resetKey) return null;
		return { resetKey: props.resetKey, failed: false, error: undefined };
	}

	componentDidCatch(error: unknown, info: ErrorInfo) {
		console.error(`pika: ${this.props.label} failed to render`, error, info.componentStack);
	}

	reset = () => this.setState({ failed: false, error: undefined });

	render() {
		if (this.state.failed) return this.props.fallback({ error: this.state.error, reset: this.reset });
		return this.props.children;
	}
}
