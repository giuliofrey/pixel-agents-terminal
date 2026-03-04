/**
 * Shared interfaces that abstract VS Code types for standalone compatibility.
 * VS Code's Webview, Terminal, and ExtensionContext naturally satisfy these interfaces.
 */

/** Abstraction over vscode.Webview — anything that can receive messages */
export interface MessageSender {
	postMessage(msg: unknown): void;
}

/** Abstraction over vscode.Terminal — a named process that can be shown/closed */
export interface TerminalLike {
	readonly name: string;
	show(): void;
	dispose(): void;
	sendText(text: string): void;
}

/** Abstraction over vscode.ExtensionContext state stores */
export interface StateStore {
	get<T>(key: string, defaultValue?: T): T | undefined;
	update(key: string, value: unknown): void | Thenable<void>;
}

/** Abstraction over vscode.ExtensionContext for persistence */
export interface PersistenceContext {
	workspaceState: StateStore;
	globalState: StateStore;
}

/** Callback to get the currently active terminal (may be undefined in standalone) */
export type ActiveTerminalProvider = () => TerminalLike | undefined;
