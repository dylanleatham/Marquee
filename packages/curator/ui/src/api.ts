// Typed client for Curator's HTTP API. Kept deliberately small — the UI reads the queue/status and
// performs the handful of actions that exist today (add, delete, Roadie controls). Editing/video/
// preview/tag flows arrive with their own build steps.

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
  generatedAt: string;
}

export type PromptType = "video" | "cardArt";

export type JobKind = "video" | "cardArt";
export type JobStatus = "running" | "done" | "failed" | "cancelled";

/** A background generation job (issue #30 / ADR 0018). Mirrors GenerationJob on the server. */
export interface GenerationJob {
  id: string;
  kind: JobKind;
  curatorId: string;
  status: JobStatus;
  /** The prompt-variant index for a per-prompt generation; absent on a whole-set job. */
  index?: number;
  progress: { done: number; total: number };
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: { videoClips?: VideoClip[]; cardArtCandidates?: CardArtCandidate[] };
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
    discogsUri?: string;
    discogsReleaseId?: number;
  };
  artwork?: {
    resolvedPath: string;
    contentHash: string;
    source?: "spotify" | "discogs";
  };
  palette?: {
    colors: PaletteColor[];
    generatedAt?: string;
    algorithm?: string;
    handEdited?: boolean;
    insufficient?: boolean;
    reason?: string;
  };
  pattern?: { type: string; params: Record<string, unknown> };
  promptDrafts?: { video?: DraftedPrompt; cardArt?: DraftedPrompt };
  visualizer?: Visualizer;
  videoClips?: VideoClip[];
  cardArt?: CardArt;
  cardArtCandidates?: CardArtCandidate[];
  tag?: {
    payload: string;
    sleeve?: { written: boolean; writtenAt?: string; tagUid?: string };
    card?: { written: boolean; writtenAt?: string; tagUid?: string };
  };
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

/** Discogs settings status for the Settings screen (GET /api/settings/discogs). */
export interface DiscogsSettings {
  configured: boolean;
  /** Whether OAuth consumer creds are set, so "log in with Discogs" is available (issue #59). */
  oauthConfigured: boolean;
  username: string | null;
}

/** Discogs OAuth login status (GET /api/discogs/auth/status). */
export interface DiscogsAuthStatus {
  connected: boolean;
  username?: string;
}

/** A row from GET /api/albums — the Demo Room uses `hasVideo` to build its swap list. */
export interface AlbumSummary {
  curatorId: string;
  title: string;
  artist: string;
  source: string;
  state: RoadieState;
  artwork: string | null;
  paletteColors: number;
  hasVideo: boolean;
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
  service: "conductor" | "backdrop" | "amp";
  configured: boolean;
  reachable: boolean;
  url?: string;
  detail?: string;
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
  generateCardArt: boolean;
  generateVideo: boolean;
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
  demoPlay: (curatorId: string) =>
    req<{ playbackId?: string }>("/api/demo/play", {
      method: "POST",
      body: JSON.stringify({ curatorId }),
    }),
  demoStop: () =>
    req<{ stopped?: boolean }>("/api/demo/stop", { method: "POST" }),
  /** Reachability of each sibling service, for the Settings screen (issue #101). */
  serviceHealth: () =>
    req<{ services: ServiceHealth[] }>("/api/settings/service-health"),

  /** Audio leg of a rehearsal (ADR 0028). Amp-unconfigured comes back as `played:false` + a reason. */
  demoAudio: (curatorId: string) =>
    req<{ played: boolean; reason?: string }>("/api/demo/audio", {
      method: "POST",
      body: JSON.stringify({ curatorId }),
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
  /** Draft a prompt type on request (ADR 0027) — onboarding no longer pre-computes it. */
  draftPrompt: (id: string, type: PromptType) =>
    req<{ promptDrafts: AlbumAsset["promptDrafts"] }>(
      `/api/albums/${id}/prompts/${type}/draft`,
      { method: "POST" },
    ),
  redraftPrompt: (id: string, type: PromptType, template: string) =>
    req<{ promptDrafts: AlbumAsset["promptDrafts"] }>(
      `/api/albums/${id}/prompts/${type}/redraft`,
      { method: "POST", body: JSON.stringify({ template }) },
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
  job: (jobId: string) => req<GenerationJob>(`/api/jobs/${jobId}`),
  // Cancel an in-flight generation job (issue #57).
  cancelJob: (jobId: string) =>
    req<GenerationJob>(`/api/jobs/${jobId}/cancel`, { method: "POST" }),
  albumJobs: (id: string, kind?: JobKind) =>
    req<{ jobs: GenerationJob[] }>(
      `/api/albums/${id}/jobs${kind ? `?kind=${kind}` : ""}`,
    ),
  selectCardArt: (id: string, index: number) =>
    req<{ cardArt: CardArt }>(`/api/albums/${id}/card-art/select`, {
      method: "POST",
      body: JSON.stringify({ index }),
    }),
  detachCardArt: (id: string, del = false) =>
    req<{ detached: string }>(
      `/api/albums/${id}/detach-card-art${del ? "?delete=1" : ""}`,
      { method: "POST" },
    ),
  approvePreview: (id: string) =>
    req<{ state: RoadieState }>(`/api/albums/${id}/preview/approve`, {
      method: "POST",
    }),
  rejectPreview: (id: string, to: "awaiting_review" | "awaiting_video") =>
    req<{ state: RoadieState }>(`/api/albums/${id}/preview/reject`, {
      method: "POST",
      body: JSON.stringify({ to }),
    }),
  // --- Tag write / verify (step 11) ---
  markTagWritten: (id: string, object: "sleeve" | "card") =>
    req<{ state: RoadieState }>(`/api/albums/${id}/tag-written`, {
      method: "POST",
      body: JSON.stringify({ object }),
    }),
  verifyAlbum: (id: string) =>
    req<{
      state: RoadieState;
      verify: { ok: boolean; discrepancies: string[] };
    }>(`/api/albums/${id}/verify-physical`, { method: "POST" }),
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
export const cardArtPrintUrl = (id: string) =>
  `/api/albums/${id}/card-art/print`;
export const cardArtCandidateUrl = (id: string, index: number) =>
  `/api/albums/${id}/card-art/candidate/${index}`;

/** Prompt-template options (roadie-spec §7), for the redraft dropdowns. */
export const VIDEO_TEMPLATES = [
  "abstract_flow",
  "particle_drift",
  "geometric_pulse",
  "analog_film",
  "psychedelic",
  "minimal_gradient",
];
export const CARD_ART_TEMPLATES = [
  "iconic_emblem",
  "abstract_scene",
  "typographic",
  "photograph_style",
  "collage",
];
