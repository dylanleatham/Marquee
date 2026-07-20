import type { Command, BrowserEvent } from "./types.js";

/** The subset of a ws WebSocket the hub needs. Lets tests use a plain stub. */
export interface Socket {
  send(data: string): void;
  readyState?: number;
}

/** What the controller depends on: push a command to the browser(s), and know if any are attached. */
export interface Broadcaster {
  broadcast(cmd: Command): void;
  connectedCount(): number;
}

const OPEN = 1; // ws.OPEN

/**
 * Tracks connected Chromium clients and fans commands out to them (backdrop-spec §10). Normally
 * exactly one browser (the kiosk) is attached; the Set tolerates zero (browser still booting) or a
 * few (a debug tab open alongside).
 */
export class SocketHub implements Broadcaster {
  private readonly sockets = new Set<Socket>();

  constructor(private readonly onEvent?: (ev: BrowserEvent) => void) {}

  add(socket: Socket): void {
    this.sockets.add(socket);
  }

  remove(socket: Socket): void {
    this.sockets.delete(socket);
  }

  /** Parse and forward a browser→backend message (observability only). Bad JSON is ignored. */
  receive(raw: string): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(JSON.parse(raw) as BrowserEvent);
    } catch {
      // A malformed frame from the browser must never take the backend down.
    }
  }

  broadcast(cmd: Command): void {
    const data = JSON.stringify(cmd);
    for (const s of this.sockets) {
      if (s.readyState !== undefined && s.readyState !== OPEN) continue;
      try {
        s.send(data);
      } catch {
        // A dead socket shouldn't block delivery to the others; the close handler will evict it.
      }
    }
  }

  connectedCount(): number {
    return this.sockets.size;
  }
}
