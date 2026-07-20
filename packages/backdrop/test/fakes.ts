import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Timers } from "../src/controller.js";
import type { Command } from "../src/types.js";
import type { Broadcaster } from "../src/hub.js";

/** Deterministic timer port — mirrors hue-conductor's FakeTimers so idle-timeout tests don't wait. */
export class FakeTimers implements Timers {
  private readonly handlers = new Map<
    number,
    { fn: () => void; ms: number; cleared: boolean }
  >();
  private nextId = 1;

  set(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.handlers.set(id, { fn, ms, cleared: false });
    return id;
  }

  clear(handle: unknown): void {
    const h = this.handlers.get(handle as number);
    if (h) h.cleared = true;
  }

  /** Fire every live timer whose delay is `ms`. */
  fire(ms: number): void {
    for (const h of this.handlers.values())
      if (!h.cleared && h.ms === ms) h.fn();
  }

  /** Count of live (uncleared) timers at a given delay. */
  activeAt(ms: number): number {
    let n = 0;
    for (const h of this.handlers.values()) if (!h.cleared && h.ms === ms) n++;
    return n;
  }
}

/** A Broadcaster that records every command instead of sending it over a socket. */
export class RecordingHub implements Broadcaster {
  readonly commands: Command[] = [];
  private connected = 0;
  broadcast(cmd: Command): void {
    this.commands.push(cmd);
  }
  connectedCount(): number {
    return this.connected;
  }
  setConnected(n: number): void {
    this.connected = n;
  }
  last(): Command | undefined {
    return this.commands[this.commands.length - 1];
  }
}

/** A temp media dir with `names` written as tiny placeholder video files. Returns dir + paths. */
export function tempMedia(names: string[]): {
  dir: string;
  paths: Record<string, string>;
} {
  const dir = mkdtempSync(join(tmpdir(), "backdrop-media-"));
  const paths: Record<string, string> = {};
  for (const name of names) {
    const p = join(dir, name);
    writeFileSync(p, "not-a-real-mp4"); // controller only checks existence, never decodes
    paths[name] = p;
  }
  return { dir, paths };
}

export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "backdrop-data-"));
}
