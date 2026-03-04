/**
 * Pixel Agents Standalone CLI
 *
 * Usage:
 *   pixel-agents [workspace-dir] [--port PORT]
 *
 * Opens a browser-based pixel art office that visualizes Claude Code agent activity.
 * Agents are spawned as background processes when you click "+ Agent" in the UI.
 */

import { StandaloneServer } from './server.js';

const DEFAULT_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65535;

function parseArgs(): { workspaceDir: string; port: number } {
	const args = process.argv.slice(2);
	let workspaceDir = process.cwd();
	let port = DEFAULT_PORT;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--port' && args[i + 1]) {
			port = parseInt(args[i + 1], 10);
			if (isNaN(port) || port < MIN_PORT || port > MAX_PORT) {
				console.error(`Invalid port: ${args[i + 1]}`);
				process.exit(1);
			}
			i++;
		} else if (args[i] === '--help' || args[i] === '-h') {
			console.log(`
Pixel Agents — Standalone Terminal Mode

Usage:
  pixel-agents [workspace-dir] [--port PORT]

Arguments:
  workspace-dir   Path to your project workspace (default: current directory)
  --port PORT     HTTP server port (default: ${DEFAULT_PORT})

Description:
  Launches a local web server that serves the Pixel Agents pixel art office.
  Open the displayed URL in your browser to see animated characters representing
  your Claude Code agents at work.

  Click "+ Agent" in the browser UI to spawn a new Claude Code agent process.
  The agents run in the background and their activity is visualized in real-time.
`);
			process.exit(0);
		} else if (!args[i].startsWith('-')) {
			workspaceDir = args[i];
		}
	}

	return { workspaceDir, port };
}

function main(): void {
	const { workspaceDir, port } = parseArgs();

	const server = new StandaloneServer(port, workspaceDir);

	// Graceful shutdown
	const shutdown = () => {
		console.log('\n🛑 Shutting down Pixel Agents...');
		server.stop();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	server.start();
}

main();
