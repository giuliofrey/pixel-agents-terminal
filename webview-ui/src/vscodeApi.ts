interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function createApi(): VsCodeApi {
  // VS Code webview environment
  if (typeof acquireVsCodeApi === 'function') {
    return acquireVsCodeApi();
  }

  // Standalone mode — use WebSocket
  let ws: WebSocket | null = null;
  let messageQueue: unknown[] = [];

  function connect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
      // Flush any messages queued while connecting
      for (const msg of messageQueue) {
        ws!.send(JSON.stringify(msg));
      }
      messageQueue = [];
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string);
        // Dispatch as if it came from VS Code's postMessage
        window.dispatchEvent(new MessageEvent('message', { data }));
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      ws = null;
      // Reconnect after a delay
      setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      // onclose will fire next, which handles reconnection
    };
  }

  connect();

  return {
    postMessage(msg: unknown): void {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      } else {
        messageQueue.push(msg);
      }
    },
  };
}

export const vscode = createApi();
