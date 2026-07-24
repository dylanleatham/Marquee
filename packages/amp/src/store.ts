import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Settings {
  /** Sonos room/group name to play cards on; null until configured. */
  targetRoom: string | null;
  updatedAt: string;
}

interface StoreData {
  settings: Settings;
}

const empty = (defaultTargetRoom: string | null): StoreData => ({
  settings: {
    targetRoom: defaultTargetRoom,
    updatedAt: new Date(0).toISOString(),
  },
});

/**
 * Tiny JSON-file store for Amp's settings (the target Sonos room). Mirrors hue-conductor's Store —
 * a JSON file, not SQLite, just for persistence across restarts. Lives in the gitignored data dir.
 * A `defaultTargetRoom` from config seeds the value only when nothing is persisted yet.
 */
export class Store {
  private readonly file: string;
  private data: StoreData;

  constructor(dataDir: string, defaultTargetRoom: string | null = null) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "amp.json");
    this.data = existsSync(this.file)
      ? {
          ...empty(defaultTargetRoom),
          ...(JSON.parse(
            readFileSync(this.file, "utf8"),
          ) as Partial<StoreData>),
        }
      : empty(defaultTargetRoom);
  }

  get settings(): Settings {
    return this.data.settings;
  }

  setTargetRoom(room: string | null): Settings {
    this.data.settings = {
      targetRoom: room,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return this.data.settings;
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
