import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface BridgeRecord {
  id: string;
  ip: string;
  applicationKey: string; // Hue's term for the API key — a secret
  /**
   * The DTLS pre-shared key for the Entertainment API (streaming effects, ADR 0024). The bridge
   * returns it alongside the application key at pairing; `undefined` on records paired before we
   * captured it — re-run `pnpm pair` on the Pi to populate it.
   */
  clientkey?: string;
  pairedAt: string;
}

export interface Settings {
  listeningRoomId: string | null;
  /**
   * The Hue *entertainment area* id used for streaming effects (ADR 0024) — a separate concept from
   * `listeningRoomId` (a Room), carrying per-light positions. `null` until configured; streaming
   * effects fall back to the CLIP path when unset.
   */
  entertainmentAreaId: string | null;
  updatedAt: string;
}

interface StoreData {
  bridge: BridgeRecord | null;
  settings: Settings;
}

const empty = (): StoreData => ({
  bridge: null,
  settings: {
    listeningRoomId: null,
    entertainmentAreaId: null,
    updatedAt: new Date(0).toISOString(),
  },
});

/**
 * Tiny JSON-file store for the bridge credential + settings. SQLite is overkill for a
 * single record (conductor-spec §4 says an in-memory Map is fine for the first pass; a
 * JSON file just adds persistence across restarts). Lives in the gitignored data dir.
 */
export class Store {
  private readonly file: string;
  private data: StoreData;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "conductor.json");
    this.data = existsSync(this.file)
      ? {
          ...empty(),
          ...(JSON.parse(
            readFileSync(this.file, "utf8"),
          ) as Partial<StoreData>),
        }
      : empty();
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  get bridge(): BridgeRecord | null {
    return this.data.bridge;
  }

  get settings(): Settings {
    return this.data.settings;
  }

  saveBridge(bridge: BridgeRecord): void {
    this.data.bridge = bridge;
    this.persist();
  }

  setListeningRoom(id: string | null): Settings {
    this.data.settings = {
      ...this.data.settings,
      listeningRoomId: id,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return this.data.settings;
  }

  setEntertainmentArea(id: string | null): Settings {
    this.data.settings = {
      ...this.data.settings,
      entertainmentAreaId: id,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return this.data.settings;
  }
}
