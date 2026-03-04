/**
 * Standalone server for Pixel Agents.
 * Serves the webview UI via HTTP and communicates via WebSocket.
 * Manages Claude agent processes via child_process instead of VS Code terminals.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as crypto from 'crypto';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { AgentState } from '../types.js';
import type { MessageSender, PersistenceContext, StateStore, TerminalLike } from '../interfaces.js';
import type { TerminalFactory } from '../agentManager.js';
import {
	launchNewTerminal,
	removeAgent,
	persistAgents as persistAgentsFn,
	sendExistingAgents,
	sendLayout,
	getProjectDirPath,
} from '../agentManager.js';
import { ensureProjectScan } from '../fileWatcher.js';
import {
	loadFurnitureAssets,
	sendAssetsToWebview,
	loadFloorTiles,
	sendFloorTilesToWebview,
	loadWallTiles,
	sendWallTilesToWebview,
	loadCharacterSprites,
	sendCharacterSpritesToWebview,
	loadDefaultLayout,
} from '../assetLoader.js';
import { WORKSPACE_KEY_AGENT_SEATS, GLOBAL_KEY_SOUND_ENABLED } from '../constants.js';
import { writeLayoutToFile, readLayoutFromFile, watchLayoutFile } from '../layoutPersistence.js';
import type { LayoutWatcher } from '../layoutPersistence.js';
import { ProcessTerminal } from './processTerminal.js';

// ── MIME types for static file serving ────────────────────────
const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.ico': 'image/x-icon',
};

// ── File-based persistence (replaces VS Code workspaceState/globalState) ──
class FileStateStore implements StateStore {
	private data: Record<string, unknown> = {};
	private filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(this.filePath)) {
				const raw = fs.readFileSync(this.filePath, 'utf-8');
				this.data = JSON.parse(raw);
			}
		} catch {
			this.data = {};
		}
	}

	private save(): void {
		try {
			const dir = path.dirname(this.filePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
		} catch (err) {
			console.error('[FileStateStore] Failed to save:', err);
		}
	}

	get<T>(key: string, defaultValue?: T): T | undefined {
		const val = this.data[key];
		if (val === undefined) {
			return defaultValue;
		}
		return val as T;
	}

	update(key: string, value: unknown): void {
		if (value === undefined) {
			delete this.data[key];
		} else {
			this.data[key] = value;
		}
		this.save();
	}
}

// ── WebSocket message sender (replaces VS Code Webview.postMessage) ──
class WebSocketSender implements MessageSender {
	private clients = new Set<WebSocket>();

	addClient(ws: WebSocket): void {
		this.clients.add(ws);
	}

	removeClient(ws: WebSocket): void {
		this.clients.delete(ws);
	}

	postMessage(msg: unknown): void {
		const data = JSON.stringify(msg);
		for (const client of this.clients) {
			if (client.readyState === 1 /* WebSocket.OPEN */) {
				client.send(data);
			}
		}
	}

	get hasClients(): boolean {
		return this.clients.size > 0;
	}
}

// ── Main standalone server ──
export class StandaloneServer {
	private httpServer: http.Server;
	private wss: WebSocketServer;
	private sender = new WebSocketSender();
	private workspaceDir: string;
	private assetsRoot: string;

	// Agent state (mirrors PixelAgentsViewProvider)
	private nextAgentId = { current: 1 };
	private nextTerminalIndex = { current: 1 };
	private agents = new Map<number, AgentState>();
	private activeAgentId = { current: null as number | null };
	private knownJsonlFiles = new Set<string>();
	private projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
	private fileWatchers = new Map<number, fs.FSWatcher>();
	private pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
	private waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
	private permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
	private jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

	private context: PersistenceContext;
	private defaultLayout: Record<string, unknown> | null = null;
	private layoutWatcher: LayoutWatcher | null = null;
	private processTerminals = new Map<number, ProcessTerminal>();

	constructor(
		private port: number,
		workspaceDir: string,
	) {
		this.workspaceDir = path.resolve(workspaceDir);

		// Determine assets root: check dist/assets first (built), then workspace
		const distAssets = path.join(__dirname, 'assets');
		if (fs.existsSync(distAssets)) {
			this.assetsRoot = __dirname;
		} else {
			// Development: try webview-ui/public/assets relative to package root
			const devAssets = path.join(__dirname, '..', 'webview-ui', 'public', 'assets');
			if (fs.existsSync(devAssets)) {
				this.assetsRoot = path.join(__dirname, '..', 'webview-ui', 'public');
			} else {
				this.assetsRoot = this.workspaceDir;
			}
		}

		// Create file-based persistence
		const stateDir = path.join(os.homedir(), '.pixel-agents', 'standalone-state');
		const workspaceHash = this.workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-');
		this.context = {
			workspaceState: new FileStateStore(path.join(stateDir, `${workspaceHash}.json`)),
			globalState: new FileStateStore(path.join(stateDir, 'global.json')),
		};

		// Set up HTTP server for static files
		this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));

		// Set up WebSocket server
		this.wss = new WebSocketServer({ server: this.httpServer });
		this.wss.on('connection', (ws) => this.handleWebSocketConnection(ws));
	}

	start(): void {
		this.httpServer.listen(this.port, () => {
			console.log(`\n🎮 Pixel Agents standalone server running at http://localhost:${this.port}`);
			console.log(`📁 Workspace: ${this.workspaceDir}`);
			console.log(`📦 Assets: ${this.assetsRoot}`);
			console.log(`\nOpen http://localhost:${this.port} in your browser to view the pixel office.\n`);
		});
	}

	stop(): void {
		// Clean up all agents
		for (const [id] of this.agents) {
			const pt = this.processTerminals.get(id);
			if (pt) {
				pt.dispose();
			}
			removeAgent(
				id, this.agents,
				this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
				this.jsonlPollTimers, this.persistAgents,
			);
		}
		if (this.projectScanTimer.current) {
			clearInterval(this.projectScanTimer.current);
			this.projectScanTimer.current = null;
		}
		this.layoutWatcher?.dispose();
		this.wss.close();
		this.httpServer.close();
	}

	private persistAgents = (): void => {
		persistAgentsFn(this.agents, this.context);
	};

	// ── HTTP static file handler ──
	private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = new URL(req.url || '/', `http://localhost:${this.port}`);
		let filePath = url.pathname;

		// Serve webview build
		if (filePath === '/' || filePath === '/index.html') {
			filePath = '/index.html';
		}

		// Resolve to webview directory (dist/webview/ when running from dist/standalone.js)
		const webviewDir = path.join(__dirname, 'webview');
		const fullPath = path.join(webviewDir, filePath);

		// Security: prevent directory traversal
		if (!fullPath.startsWith(webviewDir)) {
			res.writeHead(403);
			res.end('Forbidden');
			return;
		}

		if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
			res.writeHead(404);
			res.end('Not Found');
			return;
		}

		const ext = path.extname(fullPath).toLowerCase();
		const contentType = MIME_TYPES[ext] || 'application/octet-stream';

		const content = fs.readFileSync(fullPath);
		res.writeHead(200, { 'Content-Type': contentType });
		res.end(content);
	}

	// ── WebSocket connection handler ──
	private handleWebSocketConnection(ws: WebSocket): void {
		console.log('[Standalone] WebSocket client connected');
		this.sender.addClient(ws);

		ws.on('message', (data) => {
			try {
				const message = JSON.parse(data.toString());
				this.handleMessage(message);
			} catch (err) {
				console.error('[Standalone] Failed to parse message:', err);
			}
		});

		ws.on('close', () => {
			console.log('[Standalone] WebSocket client disconnected');
			this.sender.removeClient(ws);
		});
	}

	// ── Message handler (mirrors PixelAgentsViewProvider) ──
	private async handleMessage(message: Record<string, unknown>): Promise<void> {
		const type = message.type as string;

		if (type === 'openClaude') {
			await launchNewTerminal(
				this.nextAgentId, this.nextTerminalIndex,
				this.agents, this.activeAgentId, this.knownJsonlFiles,
				this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
				this.jsonlPollTimers, this.projectScanTimer,
				this.sender, this.persistAgents,
				this.createTerminalFactory(),
				this.workspaceDir,
				false,
			);
		} else if (type === 'focusAgent') {
			// In standalone mode, no terminal to focus — ignore
		} else if (type === 'closeAgent') {
			const agentId = message.id as number;
			const pt = this.processTerminals.get(agentId);
			if (pt) {
				pt.dispose();
			}
		} else if (type === 'saveAgentSeats') {
			this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, message.seats);
		} else if (type === 'saveLayout') {
			this.layoutWatcher?.markOwnWrite();
			writeLayoutToFile(message.layout as Record<string, unknown>);
		} else if (type === 'setSoundEnabled') {
			this.context.globalState.update(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
		} else if (type === 'webviewReady') {
			await this.handleWebviewReady();
		} else if (type === 'exportLayout') {
			// In standalone mode, layout export/import is handled client-side
			const layout = readLayoutFromFile();
			if (layout) {
				this.sender.postMessage({ type: 'exportLayoutData', layout });
			}
		} else if (type === 'importLayout') {
			// Client will send the imported layout data directly
			if (message.layout) {
				const imported = message.layout as Record<string, unknown>;
				if (imported.version === 1 && Array.isArray(imported.tiles)) {
					this.layoutWatcher?.markOwnWrite();
					writeLayoutToFile(imported);
					this.sender.postMessage({ type: 'layoutLoaded', layout: imported });
				}
			}
		}
	}

	// ── WebviewReady handler (loads assets + layout) ──
	private async handleWebviewReady(): Promise<void> {
		// Send persisted settings
		const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
		this.sender.postMessage({ type: 'settingsLoaded', soundEnabled });

		// Set up project scanning
		const projectDir = getProjectDirPath(this.workspaceDir);
		console.log('[Standalone] workspaceDir:', this.workspaceDir);
		console.log('[Standalone] projectDir:', projectDir);

		if (projectDir) {
			ensureProjectScan(
				projectDir, this.knownJsonlFiles, this.projectScanTimer, this.activeAgentId,
				this.nextAgentId, this.agents,
				this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
				this.sender, this.persistAgents,
			);
		}

		// Load assets
		await this.loadAndSendAssets();

		// Send existing agents
		sendExistingAgents(this.agents, this.context, this.sender);
	}

	// ── Asset loading ──
	private async loadAndSendAssets(): Promise<void> {
		try {
			console.log('[Standalone] Loading assets from:', this.assetsRoot);

			// Load bundled default layout
			this.defaultLayout = loadDefaultLayout(this.assetsRoot);

			// Load character sprites
			const charSprites = await loadCharacterSprites(this.assetsRoot);
			if (charSprites) {
				sendCharacterSpritesToWebview(this.sender, charSprites);
			}

			// Load floor tiles
			const floorTiles = await loadFloorTiles(this.assetsRoot);
			if (floorTiles) {
				sendFloorTilesToWebview(this.sender, floorTiles);
			}

			// Load wall tiles
			const wallTiles = await loadWallTiles(this.assetsRoot);
			if (wallTiles) {
				sendWallTilesToWebview(this.sender, wallTiles);
			}

			// Load furniture assets
			const assets = await loadFurnitureAssets(this.assetsRoot);
			if (assets) {
				sendAssetsToWebview(this.sender, assets);
			}
		} catch (err) {
			console.error('[Standalone] Error loading assets:', err);
		}

		// Send layout
		sendLayout(this.context, this.sender, this.defaultLayout);
		this.startLayoutWatcher();
	}

	private startLayoutWatcher(): void {
		if (this.layoutWatcher) {
			return;
		}
		this.layoutWatcher = watchLayoutFile((layout) => {
			console.log('[Standalone] External layout change — pushing to clients');
			this.sender.postMessage({ type: 'layoutLoaded', layout });
		});
	}

	// ── Terminal factory for spawning Claude processes ──
	private createTerminalFactory(): TerminalFactory {
		return (name: string, cwd: string | undefined) => {
			const sessionId = crypto.randomUUID();
			const terminal = new ProcessTerminal(name, sessionId, cwd);

			// Track the process terminal for lifecycle management
			// We'll associate it with the agent ID after launchNewTerminal sets it up
			terminal.onClose(() => {
				// Find and remove the agent associated with this terminal
				for (const [id, agent] of this.agents) {
					if (agent.terminalRef === terminal) {
						this.processTerminals.delete(id);
						removeAgent(
							id, this.agents,
							this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
							this.jsonlPollTimers, this.persistAgents,
						);
						this.sender.postMessage({ type: 'agentClosed', id });
						break;
					}
				}
			});

			// Store for cleanup — we'll update the mapping after launchNewTerminal
			// Use nextAgentId.current as the upcoming agent ID
			this.processTerminals.set(this.nextAgentId.current, terminal);

			return { terminal: terminal as TerminalLike, sessionId };
		};
	}
}
