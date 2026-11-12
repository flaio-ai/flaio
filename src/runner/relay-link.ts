// ---------------------------------------------------------------------------
// Minimal relay connection for the headless cloud runner: one WebSocket, no
// reconnects, no token refresh. A close is final (the runner exits).
// ---------------------------------------------------------------------------

import type { CliToRelayMsg } from "../relay/relay-protocol.js";

export interface RelayLink {
  send(msg: CliToRelayMsg): void;
  onMessage(listener: (msg: unknown) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(): void;
  readonly open: boolean;
}

export type ConnectRelay = (url: string) => Promise<RelayLink>;

/** Open a WebSocket to the relay. Resolves once open; rejects on error before open. */
export const connectRelay: ConnectRelay = async (url) => {
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(url);
  const messageListeners: ((msg: unknown) => void)[] = [];
  const closeListeners: ((reason: string) => void)[] = [];
  let closed = false;

  const emitClose = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const l of closeListeners) l(reason);
  };

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(new Error(`Relay connection failed: ${err.message}`)));
  });

  ws.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    for (const l of messageListeners) l(parsed);
  });
  ws.on("close", (code) => emitClose(`closed (${code})`));
  ws.on("error", (err) => emitClose(`error: ${err.message}`));

  return {
    send(msg) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    close() {
      try {
        ws.close(1000, "runner done");
      } catch {}
    },
    get open() {
      return ws.readyState === ws.OPEN;
    },
  };
};
