/**
 * ProcessTerminal - Implements TerminalLike using child_process.
 * Spawns `claude` as a background process and tracks its lifecycle.
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { TerminalLike } from '../interfaces.js';

export class ProcessTerminal implements TerminalLike {
	readonly name: string;
	readonly sessionId: string;
	private process: ChildProcess | null = null;
	private _onClose: (() => void) | null = null;

	constructor(name: string, sessionId: string, cwd: string | undefined) {
		this.name = name;
		this.sessionId = sessionId;

		this.process = spawn('claude', ['--session-id', sessionId], {
			cwd: cwd || process.cwd(),
			stdio: 'ignore',
			detached: false,
			env: { ...process.env },
		});

		this.process.on('exit', () => {
			this.process = null;
			this._onClose?.();
		});

		this.process.on('error', (err) => {
			console.error(`[ProcessTerminal] Error spawning claude for ${name}:`, err.message);
			this.process = null;
			this._onClose?.();
		});

		if (this.process.pid) {
			console.log(`[ProcessTerminal] Spawned claude process for ${name} (session: ${sessionId}, pid: ${this.process.pid})`);
		}
	}

	/** Register a callback for when the process exits */
	onClose(callback: () => void): void {
		this._onClose = callback;
	}

	show(): void {
		// In standalone mode, there's no terminal to show.
		// The process runs in the background.
	}

	dispose(): void {
		if (this.process) {
			console.log(`[ProcessTerminal] Killing process ${this.name} (pid: ${this.process.pid})`);
			this.process.kill('SIGTERM');
			this.process = null;
		}
	}

	sendText(_text: string): void {
		// In standalone mode, we spawn claude directly with --session-id,
		// so there's no need to send text to stdin.
	}
}
