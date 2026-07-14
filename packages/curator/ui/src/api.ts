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

export interface DraftedPrompt {
  text: string;
  template: string;
  generatedAt: string;
  copiedAt?: string;
}

export interface Visualizer {
  fileId: string;
  originalFilename: string;
  durationSec?: number;
  resolution?: string;
  loopStrategy: "loop";
}

export interface CardArt {
  fileId: string;
  originalFilename: string;
  ext: string;
  resolution?: string;
  orientation?: "landscape" | "portrait";
}

export type PromptType = "video" | "cardArt";

export interface AlbumAsset {
  curatorId: string;
  createdAt: string;
  metadata: {
    name: string;
    artist: string;
    year?: number;
    genres?: string[];
    source: "manual" | "spotify";
    spotifyUri?: string;
  };
  artwork?: { resolvedPath: string; contentHash: string };
  palette?: { colors: PaletteColor[]; insufficient?: boolean; reason?: string };
  pattern?: { type: string; params: Record<string, unknown> };
  promptDrafts?: { video?: DraftedPrompt; cardArt?: DraftedPrompt };
  visualizer?: Visualizer;
  cardArt?: CardArt;
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
  album: (id: string) => req<AlbumAsset>(`/api/albums/${id}`),
  deleteAlbum: (id: string) =>
    req<{ deleted: string }>(`/api/albums/${id}`, { method: "DELETE" }),

  // --- onboarding actions (step 7) ---
  redraftPrompt: (id: string, type: PromptType, template: string) =>
    req<{ promptDrafts: AlbumAsset["promptDrafts"] }>(
      `/api/albums/${id}/prompts/${type}/redraft`,
      { method: "POST", body: JSON.stringify({ template }) },
    ),
  markPromptCopied: (id: string, type: PromptType) =>
    req<{ state: RoadieState }>(`/api/albums/${id}/prompts/${type}/copied`, {
      method: "POST",
    }),
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
  uploadCardArt: (id: string, form: FormData) => {
    form.set("curatorId", id);
    return req<{ cardArt: CardArt }>("/api/card-art/upload", {
      method: "POST",
      body: form,
    });
  },
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
};

/** URL for an album's cover art (may 404 until Roadie downloads it — handled by <img onError>). */
export const artworkUrl = (id: string) => `/api/albums/${id}/artwork`;
export const videoUrl = (id: string) => `/api/albums/${id}/video`;
export const thumbnailUrl = (id: string) => `/api/albums/${id}/thumbnail`;
export const cardArtUrl = (id: string) => `/api/albums/${id}/card-art`;
export const cardArtPrintUrl = (id: string) =>
  `/api/albums/${id}/card-art/print`;

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
