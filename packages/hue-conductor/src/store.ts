import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface BridgeRecord {
  id: string;
  ip: string;
  applicationKey: string; // Hue's term for the API key — a secret
  pairedAt: string;
}

export interface Settings {
  listeningRoomId: string | null;
  updatedAt: string;
}

interface StoreData {
  bridge: BridgeRecord | null;
  settings: Settings;
}

const empty = (): StoreData => ({
  bridge: null,
  settings: { listeningRoomId: null, updatedAt: new Date(0).toISOString() },
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
      listeningRoomId: id,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return this.data.settings;
  }
}
