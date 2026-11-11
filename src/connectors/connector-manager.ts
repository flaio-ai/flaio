import { EventEmitter } from "node:events";
import type {
  IConnector,
  PermissionRequest,
  PermissionReply,
  ToolResult,
  SessionNotification,
} from "./connector-interface.js";

import { makeDebugLog } from "./debug.js";

const debugLog = makeDebugLog("connector-mgr");

export class ConnectorManager extends EventEmitter {
  private connectors: Map<string, IConnector> = new Map();
  private unsubs: Map<string, () => void> = new Map();

  register(connector: IConnector): void {
    this.connectors.set(connector.name, connector);
    const unsub = connector.onPrompt((prompt, sessionId) => {
      this.emit("prompt", prompt, sessionId, connector.name);
    });
    this.unsubs.set(connector.name, unsub);
  }

  unregister(name: string): void {
    this.unsubs.get(name)?.();
    this.unsubs.delete(name);
    this.connectors.delete(name);
  }

  get(name: string): IConnector | undefined {
    return this.connectors.get(name);
  }

  getAll(): IConnector[] {
    return Array.from(this.connectors.values());
  }

  async connectAll(): Promise<void> {
    const promises = Array.from(this.connectors.values()).map(async (c) => {
      try {
        await c.connect();
      } catch (err) {
        // Don't block other connectors if one fails
        this.emit("error", c.name, err);
      }
    });
    await Promise.all(promises);
  }

  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.connectors.values()).map(async (c) => {
      try {
        await c.disconnect();
      } catch {
        // Best effort
      }
    });
    await Promise.all(promises);
  }

  /**
   * Send a permission request to all connected connectors.
   * Returns the first reply received (race).
   * If no connectors are connected, returns { allowed: false }.
   */
  async requestPermission(
    request: PermissionRequest,
  ): Promise<PermissionReply & { connector: string }> {
    const connected = Array.from(this.connectors.values()).filter(
      (c) => c.status === "connected",
    );

    if (connected.length === 0) {
      return { allowed: false, message: "No connectors available", connector: "none" };
    }

    // Race: first connector to reply wins
    const reply = await Promise.race(
      connected.map(async (c) => {
        const result = await c.requestPermission(request);
        return { ...result, connector: c.name };
      }),
    );

    return reply;
  }

  /** Broadcast a tool result to all connected connectors */
  async postToolResult(result: ToolResult): Promise<void> {
    const connected = Array.from(this.connectors.values()).filter(
      (c) => c.status === "connected",
    );

    const results = await Promise.allSettled(
      connected.map((c) => c.postToolResult(result)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        debugLog(`postToolResult failed on ${connected[i].name}: ${(results[i] as PromiseRejectedResult).reason}`);
      }
    }
  }

  /** Broadcast a notification to all connected connectors */
  async postNotification(notification: SessionNotification): Promise<void> {
    const connected = Array.from(this.connectors.values()).filter(
      (c) => c.status === "connected",
    );

    const results = await Promise.allSettled(
      connected.map((c) => c.postNotification(notification)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        debugLog(`postNotification(${notification.type}) failed on ${connected[i].name}: ${(results[i] as PromiseRejectedResult).reason}`);
      }
    }
  }
}
