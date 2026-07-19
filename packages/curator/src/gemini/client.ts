// Thin Gemini (generativelanguage) API client for LLM-authored prompts + artifact generation.
// Modeled on SpotifyClient (spotify/client.ts): a `fetch`-shaped function is injectable so tests
// run against @marquee/fake-gemini instead of the network; every request has an AbortController
// timeout. Auth is the `x-goog-api-key` header (never the URL — secrets don't belong in query
// strings). `generateText` drafts prompts, `generateImage` makes card art, `generateVideo` runs the
// image-to-video long-running operation for the visualizer clips.
import { Buffer } from "node:buffer";

/** A `fetch`-shaped function — injectable so tests use the fake instead of the network. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/** A response schema (a JSON-schema subset Gemini accepts as `responseSchema`). */
export type ResponseSchema = Record<string, unknown>;

export interface GenerateTextOptions {
  /** The user turn. */
  prompt: string;
  /** Optional system instruction (the metaprompt, for drafting). */
  system?: string;
  /** Model override; defaults to the client's text model. */
  model?: string;
  /** Enable Google Search grounding. Mutually exclusive with `responseSchema` (Gemini rejects both). */
  grounded?: boolean;
  /** Ask for structured JSON matching this schema. Mutually exclusive with `grounded`. */
  responseSchema?: ResponseSchema;
  /** Sampling temperature (variance). Defaults to the model default when omitted. */
  temperature?: number;
}

export interface GeminiClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  apiBase?: string;
  /**
   * Text/JSON model. Default `gemini-flash-latest` — an alias that tracks the current GA flash model
   * (so a pinned version being retired doesn't 404). Override via config if you want a pinned slug.
   */
  textModel?: string;
  /** Image model ("Nano Banana" family). Override via config — slugs rotate; verify against your key. */
  imageModel?: string;
  /**
   * Image-to-video model (Veo, the image-referenced "Omni" model the metaprompts target). Override
   * via config — confirm the exact slug against the live API / your key's available models.
   */
  videoModel?: string;
  /** Per-request timeout (ms). A hung connection must fail fast, not hang the request. */
  timeoutMs?: number;
  /** Sleep between long-running-operation polls (injectable so tests run instantly). */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval for video generation (ms, default 10s). */
  videoPollIntervalMs?: number;
  /** Max polls before giving up on a video operation (default 60 → ~10 min at the default interval). */
  videoMaxPolls?: number;
}

/** The parts of the first candidate — text and/or inline (image) data. */
interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; inlineData?: { data?: string } }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

const API_BASE = "https://generativelanguage.googleapis.com";
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A long-running operation as returned by `:predictLongRunning` and its poll endpoint. */
interface VideoOperation {
  name?: string;
  done?: boolean;
  error?: { message?: string };
  response?: {
    // The API has moved this around across previews; probe a couple of likely shapes.
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string } }>;
    };
    generatedVideos?: Array<{ video?: { uri?: string } }>;
  };
}

export class GeminiClient {
  private readonly fetch: FetchLike;
  private readonly apiBase: string;
  private readonly textModel: string;
  private readonly imageModel: string;
  private readonly videoModel: string;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly videoPollIntervalMs: number;
  private readonly videoMaxPolls: number;

  constructor(private readonly opts: GeminiClientOptions) {
    this.fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.apiBase = opts.apiBase ?? API_BASE;
    this.textModel = opts.textModel ?? "gemini-flash-latest";
    this.imageModel = opts.imageModel ?? "gemini-2.5-flash-image";
    this.videoModel = opts.videoModel ?? "veo-3.0-generate-preview";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? realSleep;
    this.videoPollIntervalMs = opts.videoPollIntervalMs ?? 10_000;
    this.videoMaxPolls = opts.videoMaxPolls ?? 60;
  }

  /** fetch with an AbortController timeout — a hung connection rejects instead of hanging forever. */
  private async fetchT(
    input: string | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetch(input, { ...init, signal: ctrl.signal });
    } catch (err) {
      if ((err as Error)?.name === "AbortError")
        throw new GeminiError(
          `Gemini request timed out after ${this.timeoutMs}ms`,
          504,
        );
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private generateContent(
    model: string,
    body: unknown,
  ): Promise<GenerateContentResponse> {
    return this.postJson<GenerateContentResponse>(
      `/v1beta/models/${model}:generateContent`,
      body,
    );
  }

  /**
   * One text (or JSON) generation. Concatenates the first candidate's text parts. Grounding and
   * `responseSchema` cannot be combined (the API rejects it), so callers pick at most one — the
   * two-pass drafter uses grounding for research, then `responseSchema` for the structured output.
   */
  async generateText(opts: GenerateTextOptions): Promise<string> {
    if (opts.grounded && opts.responseSchema)
      throw new GeminiError(
        "generateText: grounded and responseSchema are mutually exclusive",
      );

    const generationConfig: Record<string, unknown> = {};
    if (opts.temperature !== undefined)
      generationConfig.temperature = opts.temperature;
    if (opts.responseSchema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = opts.responseSchema;
    }

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
      ...(opts.system
        ? { systemInstruction: { parts: [{ text: opts.system }] } }
        : {}),
      ...(opts.grounded ? { tools: [{ google_search: {} }] } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    };

    const data = await this.generateContent(opts.model ?? this.textModel, body);
    const blocked =
      data.promptFeedback?.blockReason ??
      data.candidates?.[0]?.finishReason === "SAFETY";
    if (blocked)
      throw new GeminiError(
        `Gemini blocked the request (${data.promptFeedback?.blockReason ?? "safety"})`,
      );

    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) throw new GeminiError("Gemini returned no text");
    return text;
  }

  /**
   * Generate one image from a text prompt (Nano Banana). Returns the raw image bytes from the first
   * inline-data part. Throws GeminiError if the response was blocked or carried no image — the
   * caller decides whether one failure among a batch is fatal.
   */
  async generateImage(prompt: string, model?: string): Promise<Buffer> {
    const data = await this.generateContent(model ?? this.imageModel, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const blocked =
      data.promptFeedback?.blockReason ??
      data.candidates?.[0]?.finishReason === "SAFETY";
    if (blocked)
      throw new GeminiError(
        `Gemini blocked the image request (${data.promptFeedback?.blockReason ?? "safety"})`,
      );

    const b64 = (data.candidates?.[0]?.content?.parts ?? []).find(
      (p) => p.inlineData?.data,
    )?.inlineData?.data;
    if (!b64) throw new GeminiError("Gemini returned no image data");
    return Buffer.from(b64, "base64");
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchT(`${this.apiBase}${path}`, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.opts.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GeminiError(
        `Gemini ${path} ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  /** Pull the finished video's download URI out of whichever response shape the op used. */
  private static videoUri(op: VideoOperation): string | undefined {
    return (
      op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ??
      op.response?.generatedVideos?.[0]?.video?.uri
    );
  }

  /**
   * Generate one image-to-video clip (Veo/"Omni"): start the long-running operation with the prompt
   * + a reference image (the album cover), poll it to completion, then download the MP4 bytes.
   * Throws GeminiError on start/poll failure, an operation error, or a timeout. The caller decides
   * whether one failure among a batch is fatal.
   */
  async generateVideo(
    prompt: string,
    imageBytes: Buffer,
    imageMimeType = "image/jpeg",
  ): Promise<Buffer> {
    // Start.
    const started = await this.postJson<VideoOperation>(
      `/v1beta/models/${this.videoModel}:predictLongRunning`,
      {
        instances: [
          {
            prompt,
            image: {
              bytesBase64Encoded: imageBytes.toString("base64"),
              mimeType: imageMimeType,
            },
          },
        ],
      },
    );
    if (!started.name)
      throw new GeminiError("Gemini video: no operation name returned");

    // Poll to completion.
    let op = started;
    for (let i = 0; !op.done; i++) {
      if (i >= this.videoMaxPolls)
        throw new GeminiError(
          `Gemini video timed out after ${this.videoMaxPolls} polls`,
          504,
        );
      await this.sleep(this.videoPollIntervalMs);
      const res = await this.fetchT(`${this.apiBase}/v1beta/${started.name}`, {
        headers: { "x-goog-api-key": this.opts.apiKey },
      });
      if (!res.ok)
        throw new GeminiError(`Gemini video poll ${res.status}`, res.status);
      op = (await res.json()) as VideoOperation;
    }
    if (op.error)
      throw new GeminiError(
        `Gemini video failed: ${op.error.message ?? "unknown"}`,
      );

    // Download.
    const uri = GeminiClient.videoUri(op);
    if (!uri) throw new GeminiError("Gemini video: no download URI in result");
    const dl = await this.fetchT(
      uri.startsWith("http") ? uri : `${this.apiBase}/v1beta/${uri}`,
      { headers: { "x-goog-api-key": this.opts.apiKey } },
    );
    if (!dl.ok)
      throw new GeminiError(`Gemini video download ${dl.status}`, dl.status);
    return Buffer.from(await dl.arrayBuffer());
  }
}
