// Typed client for Curator's HTTP API. Kept deliberately small — the UI reads the queue/status and
// performs the handful of actions that exist today (add, delete, Roadie controls). Editing/video/
// preview/tag flows arrive with their own build steps.
import type { PatternType } from "@marquee/contracts";

/** Every motion an album can be set to — the four CLIP patterns plus the three streaming effects
 * (ADR 0039). Re-exported so the UI has one name for it, alongside the shapes declared here. */
export type { PatternType };

export type RoadieState =
  | "fresh"
  | "fetching_metadata"
  | "downloading_art"
  | "generating_palette"
  | "drafting_prompts"
  | "awaiting_review"
  | "awaiting_video"
  | "awaiting_preview"
  | "awaiting_tag_write"
  | "awaiting_verify"
  | "verified"
  | "errored"
  | "needs_manual";

export interface RoadieFlags {
  palette_insufficient: boolean;
  album_not_on_spotify: boolean;
  art_override_active: boolean;
}

export interface LastError {
  message: string;
  reason?: string;
}

export interface QueueEntry {
  curatorId: string;
  title: string;
  artist: string;
  artwork: string | null;
  state: RoadieState;
  subState: string | null;
  enteredStateAt: string;
  lastError: LastError | null;
  flags: RoadieFlags;
}

/** The queue grouped by human-facing bucket (GET /api/agent/queue). */
export type QueueGroups = Record<QueueBucket, QueueEntry[]>;

export type QueueBucket =
  | "awaiting_review"
  | "awaiting_video"
  | "awaiting_preview"
  | "awaiting_tag_write"
  | "awaiting_verify"
  | "processing"
  | "errored"
  | "needs_manual"
  | "done_recently";

/** Where an album sits among its same-state peers (issue #94). */
export interface Peer {
  curatorId: string;
  title: string;
}

export interface PeerContext {
  bucket: QueueBucket;
  /** 1-based, for "3 of 7". */
  position: number;
  total: number;
  prev: Peer | null;
  next: Peer | null;
}

export interface QueueCounts {
  counts: Record<string, number>;
  needsYou: number;
}

export interface ActivityEntry {
  curatorId: string;
  from: RoadieState;
  to: RoadieState;
  at: string;
}

export interface AgentStatus {
  current: string | null;
  queueDepth: number;
  paused: boolean;
  activity: ActivityEntry[];
}

export interface PaletteColor {
  hex: string;
  role: string;
  sourceSwatch?: string;
}

export type PaletteRole = "primary" | "secondary" | "accent";

/** Where a palette's colours came from (ADR 0030). */
export type PaletteSource = "cover" | "feeling" | "blend" | "hand";

export interface PaletteCandidates {
  generatedAt: string;
  rationale: string;
  cover: PaletteColor[];
  feeling: PaletteColor[];
  blend: PaletteColor[];
}

/** One swatch as the editor sends it back: a hex, and an optional explicit role (else positional). */
export interface PaletteEditColor {
  hex: string;
  role?: PaletteRole;
}

export interface PromptVariant {
  text: string;
  nudge: string;
}

export interface DraftedPrompt {
  variants: PromptVariant[];
  selectedIndex: number;
  generator: "gemini" | "template";
  /** Style template name (template generator only). */
  template?: string;
  generatedAt: string;
  copiedAt?: string;
}

/** The active variant's text — what Copy hands off. Mirrors activePromptText on the server. */
export const activePromptText = (p: DraftedPrompt): string =>
  p.variants[p.selectedIndex]?.text ?? p.variants[0]?.text ?? "";

export interface Visualizer {
  fileId: string;
  originalFilename: string;
  durationSec?: number;
  resolution?: string;
  loopStrategy: "loop";
}

export interface VideoClip {
  index: number;
  fileId: string;
  durationSec?: number;
  resolution?: string;
  nudge?: string;
  generatedAt: string;
}

export interface CardArt {
  fileId: string;
  originalFilename: string;
  ext: string;
  resolution?: string;
  orientation?: "landscape" | "portrait";
  attachedAt: string;
}

export interface CardArtCandidate {
  index: number;
  fileId: string;
  ext: string;
  resolution?: string;
  orientation?: "landscape" | "portrait";
  nudge?: string;
  /** Generated only after the cover reference was dropped on a retry (ADR 0032). */
  coverReferenceDropped?: boolean;
  generatedAt: string;
}

/** A variant Gemini refused outright, so a missing gallery slot explains itself (ADR 0032). */
export interface CardArtRefusal {
  index: number;
  nudge?: string;
  reason: string;
  retriedWithoutCover: boolean;
  at: string;
}

export type PromptType = "video" | "cardArt";

export type JobKind =
  | "video"
  | "cardArt"
  | "paletteBatch"
  /** Streaming a visualizer to Backdrop (issue #177). Progress is bytes, not items. */
  | "mediaTransfer"
  /** Pushing the whole library to the runtime (ADR 0045). Progress is albums. */
  | "runtimeSync"
  /** Sweeping the Discogs collection into the library (issue #234). Progress is collection rows. */
  | "discogsSync"
  /** Re-matching Discogs albums to Spotify so they can play (ADR 0059). Library-scoped. */
  | "spotifyBackfill";
/**
 * The kinds that sweep the whole library rather than one album — the ones `GET /api/jobs` will
 * return and that the app-wide progress panels track.
 */
export type LibraryJobKind =
  "paletteBatch" | "runtimeSync" | "discogsSync" | "spotifyBackfill";

export type JobStatus = "running" | "done" | "failed" | "cancelled";

/** One file in flight inside a job. Mirrors JobTransfer on the server. */
export interface JobTransfer {
  /** The album whose visualizer is moving. */
  label: string;
  sent: number;
  total: number;
  /** When this file started, so an ETA survives a page opened mid-upload. */
  startedAt: string;
}

/**
 * What the screen did when the room was driven (issue #277). Separate from the lights' result
 * because the room degrades rather than fails: one can work without the other, and a dark screen
 * with no reason is indistinguishable from a record that has no visualizer.
 */
export interface ScreenLeg {
  ok: boolean;
  /** Why there is no picture — unset when `ok`. */
  reason?: string;
}

/** A background generation job (issue #30 / ADR 0018). Mirrors GenerationJob on the server. */
export interface GenerationJob {
  id: string;
  kind: JobKind;
  /** Absent on a library-scoped job — a batch sweep belongs to no one album (ADR 0029). */
  curatorId?: string;
  status: JobStatus;
  /** The prompt-variant index for a per-prompt generation; absent on a whole-set job. */
  index?: number;
  progress: { done: number; total: number };
  /**
   * The file currently streaming, when one is. Bytes — a different unit from `progress`, which
   * counts album-legs, and deliberately a different field: one channel carrying both is what made a
   * running sync read `24248819/998` (issue #268).
   */
  transfer?: JobTransfer;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: {
    videoClips?: VideoClip[];
    cardArtCandidates?: CardArtCandidate[];
    paletteBatch?: BatchPaletteReport;
    discogsSync?: DiscogsSyncReport;
    spotifyBackfill?: SpotifyBackfillReport;
  };
}

// --- batch operations (curator-spec §8/§10, issue #104) ------------------------------------------

export type BatchAddStatus = "added" | "duplicate" | "invalid" | "failed";

export interface BatchAddOutcome {
  index: number;
  input: string;
  status: BatchAddStatus;
  curatorId?: string;
  error?: string;
}

export interface BatchAddReport {
  added: number;
  duplicate: number;
  invalid: number;
  failed: number;
  curatorIds: string[];
  items: BatchAddOutcome[];
}

export type BatchPaletteStatus =
  | "regenerated"
  | "skipped_hand_edited"
  | "skipped_processing"
  | "skipped_no_art"
  | "failed";

export interface BatchPaletteOutcome {
  curatorId: string;
  label: string;
  status: BatchPaletteStatus;
  error?: string;
}

export interface BatchPaletteReport {
  total: number;
  regenerated: number;
  skipped: number;
  failed: number;
  items: BatchPaletteOutcome[];
}

/** Whether one physical sticker has been burned, and when. */
export interface TagObjectState {
  written: boolean;
  writtenAt?: string;
  tagUid?: string;
}

/**
 * The physical objects a record's URI can be written to (ADR 0034 / ADR 0058). `sleeve` is the
 * human word for the object; the URI it carries is `curator:album:`.
 */
export type TagObject = "sleeve" | "card" | "demo";

/** One track off the album, as the picker lists them. Fetched live — never stored on the asset. */
export interface Track {
  spotifyUri: string;
  name: string;
  trackNumber: number;
  discNumber: number;
  durationMs: number;
}

/** The chosen one, as it is stored (ADR 0058). */
export interface DemoTrack {
  spotifyUri: string;
  name: string;
  trackNumber?: number;
  durationMs?: number;
  chosenAt: string;
}

export interface AlbumAsset {
  curatorId: string;
  createdAt: string;
  metadata: {
    name: string;
    artist: string;
    year?: number;
    genres?: string[];
    source: "manual" | "spotify" | "discogs";
    spotifyUri?: string;
    /**
     * The Discogs→Spotify match behind `spotifyUri`/the cover, when one produced them (ADR 0059).
     * Absent for a Spotify add or a hand-entered URI — those were never guesses.
     */
    spotifyMatch?: {
      confidence: "exact" | "close";
      name: string;
      artist: string;
      year?: number;
      matchedAt: string;
    };
    discogsUri?: string;
    discogsReleaseId?: number;
  };
  artwork?: {
    resolvedPath: string;
    contentHash: string;
    /** True when a user-uploaded cover is in force instead of the fetched one (issue #100). */
    overrideActive?: boolean;
    source?: "spotify" | "discogs";
  };
  palette?: {
    colors: PaletteColor[];
    generatedAt?: string;
    algorithm?: string;
    handEdited?: boolean;
    insufficient?: boolean;
    reason?: string;
    /** Where the colours came from (ADR 0030); absent on albums predating it, read as "cover". */
    source?: PaletteSource;
    rationale?: string;
  };
  /** Proposals from the feeling pass, awaiting a choice (ADR 0030). */
  paletteCandidates?: PaletteCandidates;
  /**
   * The human's motion override (ADR 0039). Absent/null means the derived `pattern` plays — which is
   * also what a streaming pick falls back to on a room with no entertainment area configured.
   */
  patternOverride?: PatternType | null;
  /** Tuning for `patternOverride` (ADR 0036/0039). Only knobs moved off their default are stored. */
  patternOverrideParams?: Record<string, number>;
  pattern?: { type: string; params: Record<string, unknown> };
  promptDrafts?: { video?: DraftedPrompt; cardArt?: DraftedPrompt };
  visualizer?: Visualizer;
  videoClips?: VideoClip[];
  cardArt?: CardArt;
  cardArtCandidates?: CardArtCandidate[];
  cardArtRefusals?: CardArtRefusal[];
  tag?: {
    payload: string;
    sleeve?: TagObjectState;
    card?: TagObjectState;
    /** The demo tag (ADR 0058) — optional, so absent is the normal case, not an unwritten one. */
    demo?: TagObjectState;
  };
  /** The one track a demo tag plays (ADR 0058). Absent/null → it plays the album, as a card does. */
  demoTrack?: DemoTrack | null;
  verification?: { previewApprovedAt?: string; physicallyVerifiedAt?: string };
  roadie: {
    state: RoadieState;
    subState: string | null;
    flags: RoadieFlags;
    history: Array<{ state: string; at: string }>;
    lastError: LastError | null;
    retryCount: number;
  };
  status: { highLevel: string; next: string | null; issues: string[] };
}

export interface SpotifyAlbumMeta {
  spotifyId: string;
  spotifyUri: string;
  name: string;
  artist: string;
  year?: number;
  artUrl?: string;
}

/** One album in the user's Discogs collection (GET /api/discogs/collection). */
export interface DiscogsCollectionItem {
  releaseId: number;
  discogsUri: string;
  title: string;
  artist: string;
  year?: number;
  genres: string[];
  coverImage?: string;
  thumb?: string;
}

/** A page of the Discogs collection, with pagination info to fetch the rest. */
export interface DiscogsCollectionPage {
  items: DiscogsCollectionItem[];
  page: number;
  pages: number;
  perPage: number;
  total: number;
}

/**
 * What one Spotify-identity backfill did (ADR 0059) — the result of a `spotifyBackfill` job.
 *
 * `matched` is the number that can now play; `artOnly` matched only closely, so they keep their
 * cover and stay silent on purpose. `abandoned` means the run stopped on a streak of failures
 * (a dead token or a rate limit) rather than finishing.
 */
export interface SpotifyBackfillReport {
  total: number;
  matched: number;
  artOnly: number;
  noMatch: number;
  skipped: number;
  failed: number;
  abandoned?: boolean;
  items: Array<{
    curatorId: string;
    label: string;
    status: SpotifyBackfillStatus;
    matchedTo?: string;
    error?: string;
  }>;
}

/** Mirrors `SpotifyBackfillStatus` on the server (ADR 0059); the `skipped_*` ones never reach the panel. */
export type SpotifyBackfillStatus =
  | "matched"
  | "art_only"
  | "no_match"
  | "skipped_has_uri"
  | "skipped_not_discogs"
  | "skipped_processing"
  | "failed";

/** The four the progress panel renders — the skips are filtered out before it gets there. */
export type ReportedSpotifyBackfillStatus = Exclude<
  SpotifyBackfillStatus,
  `skipped_${string}`
>;

/** What one collection sweep did (issue #234) — the result of a `discogsSync` job. */
/** `collision` — the library already holds this record from another source (issue #279). */
export type DiscogsSyncStatus = "added" | "duplicate" | "collision" | "failed";

export interface DiscogsSyncOutcome {
  releaseId: number;
  /** "Artist — Title". */
  label: string;
  status: DiscogsSyncStatus;
  curatorId?: string;
  error?: string;
}

export interface DiscogsSyncReport {
  total: number;
  scanned: number;
  added: number;
  duplicate: number;
  /** Records left untouched because the library already had them from another source (#279). */
  collision: number;
  failed: number;
  pages: number;
  truncated: boolean;
  truncatedReason?: "cancelled" | "page_cap" | "fetch_failed";
  curatorIds: string[];
  items: DiscogsSyncOutcome[];
}

/** Discogs settings status for the Settings screen (GET /api/settings/discogs). */
export interface DiscogsSettings {
  configured: boolean;
  /** Whether OAuth consumer creds are set, so "log in with Discogs" is available (issue #59). */
  oauthConfigured: boolean;
  username: string | null;
  /** Whether the collection is being polled for new records right now (issue #234). */
  autoSync: boolean;
  /** The live poll interval, already clamped to the poller's floor. */
  autoSyncIntervalMinutes: number;
}

/** Auto-sync poller state (GET /api/discogs/sync/status). */
export interface DiscogsPollerStatus {
  enabled: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  lastJobId: string | null;
  lastError: string | null;
}

/** Discogs OAuth login status (GET /api/discogs/auth/status). */
export interface DiscogsAuthStatus {
  connected: boolean;
  username?: string;
}

/**
 * A row from GET /api/albums — the Demo Room uses `hasVideo` to build its swap list, and the
 * collection reads the rest.
 *
 * Everything from `year` down is a *fact about the asset*, not a verdict: the collection derives
 * what a record still needs from these through `needs.ts` (ADR 0052), so the grid and the record
 * page can't disagree about it.
 */
export interface AlbumSummary {
  curatorId: string;
  title: string;
  artist: string;
  source: string;
  state: RoadieState;
  artwork: string | null;
  paletteColors: number;
  hasVideo: boolean;
  /** When Curator first saw it. The Discogs screen's "came in today" is a question about this. */
  createdAt: string;
  year: number | null;
  genres: string[];
  /** In order — `[0]` is the dominant. Drives the collection's art placeholder. */
  paletteHexes: string[];
  hasCardArt: boolean;
  /** Both stickers burned. One of two is not "written". */
  tagsWritten: boolean;
  previewApprovedAt: string | null;
  physicallyVerifiedAt: string | null;
  subState: string | null;
  lastError: LastError | null;
}

/** A Hue room/zone Conductor can drive (GET /api/demo/rooms). */
export interface DemoRoomInfo {
  id: string;
  name: string;
  type: string;
  lightIds: string[];
}

/**
 * One service's result from a room rehearsal (ADR 0028). `ok:false` with a `reason` covers both
 * "didn't run" (unconfigured, opted out) and "ran and failed" — the UI shows the reason either way,
 * because a rehearsal degrades rather than fails.
 */
export interface RehearsalLeg {
  /**
   * Deliberately **not** the same union as `ServiceHealth`. A rehearsal fans a scan *out* to the
   * services that consume one; Stylus is what *produces* scans and never receives one, so it can be
   * probed for reachability but can never be a leg here.
   */
  service: "conductor" | "backdrop" | "amp";
  ok: boolean;
  reason?: string;
}

/**
 * One sibling service's reachability (GET /api/settings/service-health). `configured:false` and
 * `reachable:false` are deliberately distinct — "you never set this up" and "it's down" are
 * different problems with different fixes.
 */
export interface ServiceHealth {
  service: "conductor" | "backdrop" | "amp" | "stylus";
  configured: boolean;
  reachable: boolean;
  url?: string;
  detail?: string;
}

/** What the reader sees, as opposed to what its state machine did (stylus-spec §8). */
export interface StylusStatus {
  state: string;
  readerId?: string;
  lastUid?: string | null;
  lastUri?: string | null;
  /** On the stand right now. `uri: null` = present but undecodable; whole object null = empty stand. */
  observed?: { uid: string; uri: string | null; at: string } | null;
  /** The last tag refused — kept after the sleeve is lifted. */
  lastBadTag?: { uid: string; uri: string | null; at: string } | null;
  downstreamHealth?: Record<string, boolean>;
}

/** One album across every host that should hold part of it (GET /api/system/status). */
export interface AlbumPresence {
  curatorId: string;
  name: string;
  artist: string;
  hasVideo: boolean;
  onConductor: boolean;
  inBackdropLibrary: boolean;
  /** Entry present **and** Backdrop confirms the bytes. Absent `fileMissing` reads as "can't tell". */
  videoOnBackdrop: boolean;
}

/** Everything at once, for the System status page (GET /api/system/status). */
export interface SystemStatus {
  at: string;
  services: ServiceHealth[];
  playing: {
    video: {
      state: string;
      uri: string | null;
      filePath: string | null;
      browserConnected?: boolean;
    } | null;
    lights: Array<{
      roomId: string;
      source?: { name?: string; artist?: string };
      pattern?: string;
      startedAt?: string;
    }> | null;
    audio: { state?: string; target?: string | null } | null;
    caveats: string[];
  };
  stylus: StylusStatus | null;
  albums: AlbumPresence[];
  jobs: GenerationJob[];
}

/** Aggregate Conductor health for the Demo Room header (GET /api/demo/status). */
export interface DemoStatus {
  reachable: boolean;
  paired: boolean;
  listeningRoomId: string | null;
}

/** Spotify credential status for the Settings screen (GET /api/settings/spotify). */
export interface SpotifySettings {
  configured: boolean;
  clientId: string | null;
}

/** Spotify user-login status for the Settings screen (GET /api/spotify/auth/status). */
export interface SpotifyAuthStatus {
  connected: boolean;
  scope?: string;
}

/** Gemini status + opt-in generation flags for the Settings screen (GET /api/settings/gemini). */
export interface GeminiSettings {
  configured: boolean;
  /**
   * What the flag will be after the next restart — i.e. what you have asked for, not what the
   * running pipeline is doing. The two differ until Marquee is restarted, and binding a checkbox to
   * the *running* value is what made these look unclickable (#240).
   */
  generateCardArt: boolean;
  generateVideo: boolean;
  /**
   * Set above `settings.json` (in `config.toml` or the environment), so Settings cannot change it.
   * The screen states the value instead of offering a checkbox that would silently lose.
   */
  generateCardArtPinned: boolean;
  generateVideoPinned: boolean;
}

export interface GeminiSettingsPatch {
  apiKey?: string;
  generateCardArt?: boolean;
  generateVideo?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers:
      init?.body && !(init.body instanceof FormData)
        ? { "content-type": "application/json" }
        : undefined,
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  queue: () => req<QueueGroups>("/api/agent/queue"),
  queueCounts: () => req<QueueCounts>("/api/agent/queue/counts"),
  status: () => req<AgentStatus>("/api/agent/status"),
  pause: () => req<AgentStatus>("/api/agent/pause", { method: "POST" }),
  resume: () => req<AgentStatus>("/api/agent/resume", { method: "POST" }),
  retry: (id: string) =>
    req<{ retried: string }>(`/api/agent/retry/${id}`, { method: "POST" }),
  albums: () => req<{ albums: AlbumSummary[] }>("/api/albums"),
  album: (id: string) => req<AlbumAsset>(`/api/albums/${id}`),
  deleteAlbum: (id: string) =>
    req<{ deleted: string }>(`/api/albums/${id}`, { method: "DELETE" }),

  // --- Palette editing (curator-spec §Palettes) ---
  // Save a hand-edited palette. Order is authoritative — colors[0] is the dominant/primary.
  editPalette: (id: string, colors: PaletteEditColor[]) =>
    req<{ palette: AlbumAsset["palette"] }>(`/api/albums/${id}/palette`, {
      method: "PUT",
      body: JSON.stringify({ colors }),
    }),
  // Override an album's motion, or pass null to return it to the derived pattern (ADR 0039). The
  // derived pattern is untouched either way — a streaming pick falls back to it, a CLIP pick
  // displaces it only in the payload.
  // `params` omitted leaves existing tuning alone; `{}` resets it to the spec defaults.
  setPatternOverride: (
    id: string,
    type: PatternType | null,
    params?: Record<string, number>,
  ) =>
    req<{
      patternOverride: PatternType | null;
      patternOverrideParams: Record<string, number>;
      pattern: AlbumAsset["pattern"];
    }>(`/api/albums/${id}/pattern-override`, {
      method: "PUT",
      body: JSON.stringify(params === undefined ? { type } : { type, params }),
    }),
  // Drop the hand-edit flag (keeps the colors) so a later re-extract/batch may replace it.
  resetPalette: (id: string) =>
    req<{ palette: AlbumAsset["palette"] }>(`/api/albums/${id}/palette/reset`, {
      method: "POST",
    }),
  // Re-run Palette Press from the cover art. `force` discards a hand-edit (else the server 409s).
  regeneratePalette: (id: string, force = false) =>
    req<{ palette: AlbumAsset["palette"]; pattern: AlbumAsset["pattern"] }>(
      `/api/albums/${id}/palette/generate${force ? "?force=1" : ""}`,
      { method: "POST" },
    ),

  // --- Demo Room: drive the real Hue lights via Conductor (runtime preview) ---
  demoStatus: () => req<DemoStatus>("/api/demo/status"),
  demoRooms: () => req<{ rooms: DemoRoomInfo[] }>("/api/demo/rooms"),
  demoSetRoom: (roomId: string) =>
    req<{ listeningRoomId: string | null }>("/api/demo/room", {
      method: "PUT",
      body: JSON.stringify({ roomId }),
    }),
  /**
   * Drive the room for this album. `video: false` re-applies the lights **only** — what a pattern
   * change wants, since restarting the visualizer on every knob nudge would make tuning unusable
   * (issue #277). Placing a record leaves it unset and drives the whole room.
   */
  demoPlay: (curatorId: string, opts: { video?: boolean } = {}) =>
    req<{ playbackId?: string; video?: ScreenLeg }>("/api/demo/play", {
      method: "POST",
      body: JSON.stringify({ curatorId, ...opts }),
    }),
  demoStop: () =>
    req<{ stopped?: boolean; video?: ScreenLeg }>("/api/demo/stop", {
      method: "POST",
    }),
  /** Reachability of each sibling service, for the Settings screen (issue #101). */
  serviceHealth: () =>
    req<{ services: ServiceHealth[] }>("/api/settings/service-health"),
  /** Everything the System status page renders, in one bounded call. Always 200. */
  systemStatus: () => req<SystemStatus>("/api/system/status"),
  /** Push the whole library to the runtime — returns a job to poll (ADR 0045). */
  runtimeSync: () =>
    req<GenerationJob>("/api/runtime/sync", { method: "POST" }),
  /** Read-only drift report across Conductor and Backdrop. */
  runtimeVerify: () =>
    req<{
      conductor: {
        ok: boolean;
        missing?: string[];
        extra?: string[];
        error?: string;
      };
      backdrop?: { ok: boolean; discrepancies?: string[]; error?: string };
    }>("/api/runtime/verify", { method: "POST" }),
  /** Push one album everywhere. Available at any state, unlike verify-physical. */
  pushAlbum: (curatorId: string) =>
    req<{
      conductor: { ok: boolean; skipped?: boolean; error?: string };
      backdrop: { ok: boolean; skipped?: boolean; error?: string };
      transferJobId?: string;
    }>(`/api/albums/${curatorId}/push`, { method: "POST" }),

  /** Audio leg of a rehearsal (ADR 0028). Amp-unconfigured comes back as `played:false` + a reason. */
  demoAudio: (curatorId: string) =>
    req<{ played: boolean; reason?: string }>("/api/demo/audio", {
      method: "POST",
      body: JSON.stringify({ curatorId }),
    }),

  /**
   * Desk audio for bench preview (ADR 0037): start the album on the workstation's own Spotify
   * client. Everything that merely didn't happen — no session, no desktop client, not Premium —
   * comes back as `played:false` + a reason to show, never a thrown error.
   */
  deskAudioPlay: (id: string) =>
    req<{ played: boolean; device?: string; reason?: string }>(
      `/api/albums/${id}/desk-audio`,
      { method: "POST" },
    ),
  deskAudioPause: (id: string) =>
    req<{ paused: boolean; reason?: string }>(`/api/albums/${id}/desk-audio`, {
      method: "DELETE",
    }),

  // --- room rehearsal (ADR 0028): the real runtime path minus the physical tag ---
  simulateScan: (id: string, audio = true) =>
    req<{ services: RehearsalLeg[] }>(`/api/albums/${id}/simulate-scan`, {
      method: "POST",
      body: JSON.stringify({ audio }),
    }),
  simulateScanStop: (id: string) =>
    req<{ services: RehearsalLeg[] }>(`/api/albums/${id}/simulate-scan/stop`, {
      method: "POST",
    }),

  // --- onboarding actions (step 7) ---
  // --- artwork override (issue #100): your own cover when the fetched one is a bad scan ---
  /**
   * Upload an override. `regeneratePalette` is the user's answer to the hand-edit question — omit it
   * and the server keeps a hand-edited palette, per curator-spec §12.
   */
  uploadArtworkOverride: (
    id: string,
    file: File,
    regeneratePalette?: boolean,
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (regeneratePalette !== undefined)
      form.append("regeneratePalette", String(regeneratePalette));
    return req<{ artwork: AlbumAsset["artwork"]; paletteRegenerated: boolean }>(
      `/api/albums/${id}/artwork/override`,
      { method: "POST", body: form },
    );
  },
  removeArtworkOverride: (id: string) =>
    req<{ artwork: AlbumAsset["artwork"]; paletteRegenerated: boolean }>(
      `/api/albums/${id}/artwork/override`,
      { method: "DELETE" },
    ),

  /**
   * The album's songs, for the demo-track picker (ADR 0058). Always 200: a record with no tracklist
   * — a manual pressing, no Spotify credentials, Spotify down — comes back as an empty list and a
   * `reason` the panel shows in place, because that is an ordinary state of the screen.
   */
  tracks: (id: string) =>
    req<{ tracks: Track[]; reason?: string }>(`/api/albums/${id}/tracks`),

  /**
   * Name this album on Spotify by hand (ADR 0059). Accepts the `spotify:album:…` URI or an
   * `open.spotify.com/album/…` share link; `null` clears it (and the demo cut with it).
   */
  setSpotifyUri: (id: string, spotifyUri: string | null) =>
    req<{ spotifyUri: string | null; demoTrack: DemoTrack | null }>(
      `/api/albums/${id}/spotify-uri`,
      { method: "PUT", body: JSON.stringify({ spotifyUri }) },
    ),

  /** Choose the track a demo tag plays, or pass `null` to fall back to the whole album. */
  setDemoTrack: (id: string, track: Omit<DemoTrack, "chosenAt"> | null) =>
    req<{ demoTrack: DemoTrack | null }>(`/api/albums/${id}/demo-track`, {
      method: "PUT",
      body: JSON.stringify({ track }),
    }),

  /** The exact string to burn into a sticker, plus a QR of it (issue #102). */
  tagPayload: (id: string, object: TagObject) =>
    req<{ object: string; payload: string; qrDataUrl: string }>(
      `/api/albums/${id}/tag-payload?object=${object}`,
    ),

  /** Draft a prompt type on request (ADR 0027) — onboarding no longer pre-computes it. */
  draftPrompt: (id: string, type: PromptType) =>
    req<{ promptDrafts: AlbumAsset["promptDrafts"] }>(
      `/api/albums/${id}/prompts/${type}/draft`,
      { method: "POST" },
    ),
  markPromptCopied: (id: string, type: PromptType) =>
    req<{ state: RoadieState }>(`/api/albums/${id}/prompts/${type}/copied`, {
      method: "POST",
    }),
  selectPromptVariant: (id: string, type: PromptType, index: number) =>
    req<{ promptDrafts: AlbumAsset["promptDrafts"] }>(
      `/api/albums/${id}/prompts/${type}/select`,
      { method: "POST", body: JSON.stringify({ index }) },
    ),
  regeneratePromptAI: (id: string, type: PromptType) =>
    req<{ promptDrafts: AlbumAsset["promptDrafts"] }>(
      `/api/albums/${id}/prompts/${type}/regenerate-ai`,
      { method: "POST" },
    ),
  uploadVideo: (id: string, form: FormData) => {
    form.set("curatorId", id);
    return req<{ state: RoadieState }>("/api/videos/upload", {
      method: "POST",
      body: form,
    });
  },
  detachVideo: (id: string, del = false) =>
    req<{ state: RoadieState }>(
      `/api/albums/${id}/detach-video${del ? "?delete=1" : ""}`,
      { method: "POST" },
    ),
  // Generation is a background job (issue #30): POST returns the job (202); poll job() until done.
  generateVideoSet: (id: string) =>
    req<GenerationJob>(`/api/albums/${id}/video/generate`, { method: "POST" }),
  // Generate a single clip from one drafted video prompt variant (per-prompt button, ADR 0022).
  // Also a background job (a clip is a multi-minute Omni call), keyed on the prompt index.
  generateVideoOne: (id: string, index: number) =>
    req<GenerationJob>(`/api/albums/${id}/video/generate/${index}`, {
      method: "POST",
    }),
  // Splice the generated clips into one loop and attach it (issue #29). `order` = clip indices to
  // join, in order (default: all).
  spliceVisualizer: (id: string, order?: number[], crossfadeSec?: number) =>
    req<{ state: RoadieState; visualizer: Visualizer }>(
      `/api/albums/${id}/video/splice`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(order ? { order } : {}),
          ...(crossfadeSec ? { crossfadeSec } : {}),
        }),
      },
    ),
  uploadCardArt: (id: string, form: FormData) => {
    form.set("curatorId", id);
    return req<{ cardArt: CardArt }>("/api/card-art/upload", {
      method: "POST",
      body: form,
    });
  },
  generateCardArtSet: (id: string) =>
    req<GenerationJob>(`/api/albums/${id}/card-art/generate`, {
      method: "POST",
    }),
  // Generate a single candidate from one drafted card-art prompt variant (per-prompt button, ADR
  // 0021). Synchronous — resolves with the merged candidate list rather than a job to poll.
  generateCardArtOne: (id: string, index: number) =>
    req<{ cardArtCandidates: CardArtCandidate[] }>(
      `/api/albums/${id}/card-art/generate/${index}`,
      { method: "POST" },
    ),
  /** Propose colours from how the album sounds. Costs a Gemini call; applies nothing (ADR 0030). */
  feelingPalette: (id: string) =>
    req<{ candidates: PaletteCandidates }>(
      `/api/albums/${id}/palette/feeling`,
      { method: "POST" },
    ),
  /** Apply one of the offered palettes. `cover` re-extracts and is the undo. */
  choosePalette: (id: string, source: PaletteSource) =>
    req<{ palette: AlbumAsset["palette"]; pattern: AlbumAsset["pattern"] }>(
      `/api/albums/${id}/palette/choose`,
      { method: "POST", body: JSON.stringify({ source }) },
    ),
  job: (jobId: string) => req<GenerationJob>(`/api/jobs/${jobId}`),
  // Cancel an in-flight generation job (issue #57).
  cancelJob: (jobId: string) =>
    req<GenerationJob>(`/api/jobs/${jobId}/cancel`, { method: "POST" }),
  /** The album's neighbours at the same state, in queue order (issue #94). */
  albumPeers: (id: string) => req<PeerContext>(`/api/albums/${id}/peers`),
  albumJobs: (id: string, kind?: JobKind) =>
    req<{ jobs: GenerationJob[] }>(
      `/api/albums/${id}/jobs${kind ? `?kind=${kind}` : ""}`,
    ),
  /** Library-scoped jobs — how the batch panel reattaches to a sweep after a reload (ADR 0029). */
  libraryJobs: (kind: LibraryJobKind) =>
    req<{ jobs: GenerationJob[] }>(`/api/jobs?kind=${kind}`),
  /** Re-derive every algorithmic palette. `force` includes hand-edited ones, which are otherwise skipped. */
  /** Re-match Discogs albums to Spotify so they can play (ADR 0059). Returns the started job. */
  backfillSpotifyMatches: () =>
    req<GenerationJob>("/api/albums/spotify-backfill", { method: "POST" }),

  regeneratePalettes: (force = false) =>
    req<GenerationJob>(
      `/api/batch/regenerate-palettes${force ? "?force=1" : ""}`,
      { method: "POST" },
    ),
  selectCardArt: (id: string, index: number) =>
    req<{ cardArt: CardArt }>(`/api/albums/${id}/card-art/select`, {
      method: "POST",
      body: JSON.stringify({ index }),
    }),
  /**
   * Fetch the print render and save it, rather than pointing an `<a download>` at the route. The
   * route renders through ffmpeg now (issue #98) and so can answer 404/422/503 — which a plain
   * download link would show the human as a page of JSON. Going through fetch means a failure throws
   * an ApiError the caller's `run` reports like every other action.
   */
  downloadCardArtPrint: async (id: string, bleed = false): Promise<void> => {
    const res = await fetch(cardArtPrintUrl(id, bleed));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(
        [body.error ?? `HTTP ${res.status}`, body.reason]
          .filter(Boolean)
          .join(" — "),
        res.status,
      );
    }
    const href = URL.createObjectURL(await res.blob());
    try {
      const a = document.createElement("a");
      a.href = href;
      a.download = `${id}-card-print${bleed ? "-bleed" : ""}.png`;
      a.click();
    } finally {
      URL.revokeObjectURL(href);
    }
  },
  detachCardArt: (id: string, del = false) =>
    req<{ detached: string }>(
      `/api/albums/${id}/detach-card-art${del ? "?delete=1" : ""}`,
      { method: "POST" },
    ),
  approvePreview: (id: string) =>
    req<{ state: RoadieState; previewApprovedAt: string | null }>(
      `/api/albums/${id}/preview/approve`,
      { method: "POST" },
    ),
  rejectPreview: (id: string, to: "awaiting_review" | "awaiting_video") =>
    req<{ state: RoadieState }>(`/api/albums/${id}/preview/reject`, {
      method: "POST",
      body: JSON.stringify({ to }),
    }),
  // --- Tag write / verify (step 11) ---
  /**
   * Write the awaiting-tag-write list onto a USB-attached Flipper (issue #68). Resolves with what
   * landed; rejects with the server's message when there is no Flipper or its port is busy.
   */
  pushTagListToFlipper: () =>
    req<{
      ok: true;
      albums: number;
      port: string;
      bytes: number;
      path: string;
    }>("/api/tags/push-to-flipper", { method: "POST" }),
  /**
   * Add this album to the Flipper's tag list (issue #68) — merges into whatever is already on the
   * card rather than replacing it. `total` is the album count on the list afterwards.
   */
  pushAlbumToFlipper: (id: string) =>
    req<{
      ok: true;
      total: number;
      port: string;
      bytes: number;
      path: string;
    }>(`/api/albums/${id}/push-to-flipper`, { method: "POST" }),
  markTagWritten: (id: string, object: TagObject) =>
    req<{ state: RoadieState }>(`/api/albums/${id}/tag-written`, {
      method: "POST",
      body: JSON.stringify({ object }),
    }),
  verifyAlbum: (id: string) =>
    req<{
      state: RoadieState;
      verify: { ok: boolean; discrepancies: string[] };
    }>(`/api/albums/${id}/verify-physical`, { method: "POST" }),
  /**
   * The record page's one button for the whole tag step (ADR 0052): both stickers recorded as
   * written, and the physical check recorded, in one action. `409` until the record reaches the tag
   * step — the panel disables the button with the reason rather than offering a press that fails.
   */
  verifyTags: (id: string) =>
    req<{
      state: RoadieState;
      verify: { ok: boolean; discrepancies: string[] };
    }>(`/api/albums/${id}/tags-verified`, { method: "POST" }),
  // --- Settings: Spotify credentials (packaged app has no repo .env) ---
  spotifySettings: () => req<SpotifySettings>("/api/settings/spotify"),
  saveSpotifySettings: (clientId: string, clientSecret: string) =>
    req<{ ok: boolean; restartRequired: boolean }>("/api/settings/spotify", {
      method: "PUT",
      body: JSON.stringify({ clientId, clientSecret }),
    }),
  // --- Spotify user login (Authorization Code + PKCE) ---
  spotifyAuthStatus: () => req<SpotifyAuthStatus>("/api/spotify/auth/status"),
  spotifyLogin: () => req<{ authorizeUrl: string }>("/api/spotify/auth/login"),
  spotifyDisconnect: () =>
    req<{ ok: boolean }>("/api/spotify/auth/disconnect", { method: "POST" }),

  geminiSettings: () => req<GeminiSettings>("/api/settings/gemini"),
  saveGeminiSettings: (patch: GeminiSettingsPatch) =>
    req<{ ok: boolean; restartRequired: boolean }>("/api/settings/gemini", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  searchSpotify: (q: string) =>
    req<{ results: SpotifyAlbumMeta[] }>(
      `/api/spotify/search-albums?q=${encodeURIComponent(q)}`,
    ),
  addSpotify: (spotifyUri: string) =>
    req<{ curatorId: string; state: RoadieState }>("/api/albums", {
      method: "POST",
      body: JSON.stringify({ spotifyUri }),
    }),
  /**
   * Add a pasted list in one request. Answers 200 with a per-item report even when some lines fail —
   * partial success is the normal outcome, so read `report.items`, not the status code.
   */
  addAlbumsBatch: (items: string[]) =>
    req<BatchAddReport>("/api/albums/batch", {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  addManual: (form: FormData) =>
    req<{ curatorId: string; state: RoadieState }>("/api/albums", {
      method: "POST",
      body: form,
    }),

  // --- Discogs: browse your collection + add ---
  discogsSettings: () => req<DiscogsSettings>("/api/settings/discogs"),
  saveDiscogsSettings: (patch: {
    token?: string;
    username?: string;
    consumerKey?: string;
    consumerSecret?: string;
    autoSync?: boolean;
    autoSyncIntervalMinutes?: number;
  }) =>
    req<{ ok: boolean; restartRequired: boolean }>("/api/settings/discogs", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  // Discogs OAuth "log in with Discogs" (issue #59) — mirrors the Spotify auth methods.
  discogsAuthStatus: () => req<DiscogsAuthStatus>("/api/discogs/auth/status"),
  discogsLogin: () => req<{ authorizeUrl: string }>("/api/discogs/auth/login"),
  discogsDisconnect: () =>
    req<{ ok: boolean }>("/api/discogs/auth/disconnect", { method: "POST" }),
  discogsCollection: (page = 1, perPage = 50) =>
    req<DiscogsCollectionPage>(
      `/api/discogs/collection?page=${page}&perPage=${perPage}`,
    ),
  addDiscogs: (item: DiscogsCollectionItem) =>
    req<{ curatorId: string; state: RoadieState }>("/api/albums", {
      method: "POST",
      body: JSON.stringify({
        releaseId: item.releaseId,
        title: item.title,
        artist: item.artist,
        year: item.year,
        genres: item.genres,
        coverImage: item.coverImage,
      }),
    }),

  /**
   * Sweep the whole collection into the library (issue #234). 202 + a library-scoped job; the server
   * dedups on the release id, so this is both the first import and every later refresh, and calling
   * it during a running sweep reattaches to that one instead of starting a second.
   */
  syncDiscogs: () =>
    req<GenerationJob>("/api/discogs/sync", { method: "POST" }),
  /** Auto-sync poller state — "last checked at …" next to the Settings toggle. */
  discogsSyncStatus: () => req<DiscogsPollerStatus>("/api/discogs/sync/status"),
};

/** URL for an album's cover art (may 404 until Roadie downloads it — handled by <img onError>). */
export const artworkUrl = (id: string) => `/api/albums/${id}/artwork`;
export const videoUrl = (id: string) => `/api/albums/${id}/video`;
export const thumbnailUrl = (id: string) => `/api/albums/${id}/thumbnail`;
export const videoClipUrl = (id: string, index: number) =>
  `/api/albums/${id}/video/clip/${index}`;
export const videoClipThumbnailUrl = (id: string, index: number) =>
  `/api/albums/${id}/video/clip/${index}/thumbnail`;
export const videoClipDownloadUrl = (id: string, index: number) =>
  `/api/albums/${id}/video/clip/${index}?download=1`;
export const cardArtUrl = (id: string) => `/api/albums/${id}/card-art`;
export const cardArtPrintUrl = (id: string, bleed = false) =>
  `/api/albums/${id}/card-art/print${bleed ? "?bleed=1" : ""}`;
/** A ready-to-write `.nfc` for the Flipper (issue #67). One object per file, as the writer expects. */
export const tagNfcUrl = (id: string, object: TagObject) =>
  `/api/albums/${id}/tag.nfc?object=${object}`;
export const cardArtCandidateUrl = (id: string, index: number) =>
  `/api/albums/${id}/card-art/candidate/${index}`;
