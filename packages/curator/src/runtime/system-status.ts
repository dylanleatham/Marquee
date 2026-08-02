// One request that answers "what is the system actually doing right now" (ADR 0045 follow-on).
//
// Curator already knows what it *intends*; every failure this page exists to surface is a
// disagreement between that intention and some other host. So the shape is deliberately built
// around comparisons — which albums the runtime holds versus which Curator has, whether a library
// entry has bytes behind it — rather than around each service's own self-report.
//
// Every leg is independently nullable. One unplugged Pi must degrade its own section, never the
// request: a status page that 500s because something is down is reporting the one thing it was
// built to show, as an error.
import type { AlbumAsset } from "../albums/asset.js";
import type { GenerationJob } from "../jobs/manager.js";
import {
  getJson,
  probeService,
  type ProbeTarget,
  type ServiceHealth,
} from "./probe.js";

/** What Backdrop's `GET /api/library` returns, including the derived playability flag. */
interface BackdropLibraryResponse {
  entries: Record<
    string,
    { filePath: string; durationSec?: number; fileMissing?: boolean }
  >;
}

interface BackdropStatus {
  state: string;
  uri: string | null;
  filePath: string | null;
  browserConnected?: boolean;
}

interface ConductorPlayback {
  playback: Array<{
    roomId: string;
    source?: { name?: string; artist?: string; year?: number };
    pattern?: string;
    startedAt?: string;
  }>;
}

/** Stylus's `/status` — `observed`/`lastBadTag` are the reader's view (stylus-spec §8). */
export interface StylusStatus {
  state: string;
  readerId?: string;
  lastUid?: string | null;
  lastUri?: string | null;
  observed?: { uid: string; uri: string | null; at: string } | null;
  lastBadTag?: { uid: string; uri: string | null; at: string } | null;
  downstreamHealth?: Record<string, boolean>;
}

/** One album, across every host that should be holding some part of it. */
export interface AlbumPresence {
  curatorId: string;
  name: string;
  artist: string;
  /** Curator has a visualizer attached — without one there is nothing for Backdrop to hold. */
  hasVideo: boolean;
  /** Conductor (and Amp, same directory) has the asset, so a scan can drive the lights. */
  onConductor: boolean;
  /** Backdrop has a library entry mapping the scan URI to a file. */
  inBackdropLibrary: boolean;
  /** …and the bytes are actually there. An entry without them plays nothing (ADR 0038). */
  videoOnBackdrop: boolean;
}

export interface SystemStatus {
  at: string;
  services: ServiceHealth[];
  playing: {
    video: BackdropStatus | null;
    lights: ConductorPlayback["playback"] | null;
    audio: unknown | null;
    /** Known gaps in the above, surfaced rather than papered over — see `LIGHTS_CAVEAT`. */
    caveats: string[];
  };
  stylus: StylusStatus | null;
  albums: AlbumPresence[];
  jobs: GenerationJob[];
}

/**
 * Conductor's playback view has two documented limits, and a status page that silently implied
 * otherwise would be worse than one that admits them: a streaming pattern (aurora/shimmer/wave)
 * runs through a different engine and reports nothing here, and the view carries no curatorId — so
 * "which album is lighting the room" is matched on name, best-effort.
 */
export const LIGHTS_CAVEAT =
  "Lights show only CLIP playback: an album on a streaming pattern (aurora/shimmer/wave) reports nothing here, and Conductor's view carries no curatorId.";

export interface SystemStatusDeps {
  conductor?: ProbeTarget | undefined;
  backdrop?: ProbeTarget | undefined;
  amp?: ProbeTarget | undefined;
  stylus?: ProbeTarget | undefined;
  albums: AlbumAsset[];
  jobs: GenerationJob[];
  now?: () => string;
  fetchImpl?: typeof fetch;
}

/**
 * Gather everything in parallel. Nothing here throws; every remote read collapses to `null` and the
 * corresponding `ServiceHealth` says why.
 */
export async function buildSystemStatus(
  deps: SystemStatusDeps,
): Promise<SystemStatus> {
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date().toISOString());

  const [
    conductorHealth,
    backdropHealth,
    ampHealth,
    stylusHealth,
    conductorAssets,
    conductorPlayback,
    backdropStatus,
    backdropLibrary,
    ampStatus,
    stylusStatus,
  ] = await Promise.all([
    // Conductor's bridge status doubles as its health check — it reports whether the Hue bridge is
    // paired, which is what actually stops lights working.
    probeService("conductor", deps.conductor, "/api/bridge/status", f),
    probeService("backdrop", deps.backdrop, "/healthz", f),
    probeService("amp", deps.amp, "/api/status", f),
    probeService("stylus", deps.stylus, "/healthz", f),
    getJson<{ curatorIds: string[] }>(deps.conductor, "/api/album-assets", f),
    getJson<ConductorPlayback>(deps.conductor, "/api/playback/current", f),
    getJson<BackdropStatus>(deps.backdrop, "/api/status", f),
    getJson<BackdropLibraryResponse>(deps.backdrop, "/api/library", f),
    getJson<unknown>(deps.amp, "/api/status", f),
    getJson<StylusStatus>(deps.stylus, "/status", f),
  ]);

  const onConductor = new Set(conductorAssets?.curatorIds ?? []);
  const entries = backdropLibrary?.entries ?? {};

  const albums: AlbumPresence[] = deps.albums.map((a) => {
    const entry = entries[`curator:album:${a.curatorId}`];
    return {
      curatorId: a.curatorId,
      name: a.metadata.name,
      artist: a.metadata.artist,
      hasVideo: Boolean(a.visualizer),
      onConductor: onConductor.has(a.curatorId),
      inBackdropLibrary: Boolean(entry),
      // `fileMissing` is only reported by a Backdrop carrying that change; treat its absence as
      // "can't tell" rather than "fine", so an older runtime never claims a file it hasn't got.
      videoOnBackdrop: Boolean(entry) && entry?.fileMissing === false,
    };
  });

  return {
    at: now(),
    services: [conductorHealth, backdropHealth, ampHealth, stylusHealth],
    playing: {
      video: backdropStatus,
      lights: conductorPlayback?.playback ?? null,
      audio: ampStatus,
      caveats: [LIGHTS_CAVEAT],
    },
    stylus: stylusStatus,
    albums,
    jobs: deps.jobs,
  };
}
