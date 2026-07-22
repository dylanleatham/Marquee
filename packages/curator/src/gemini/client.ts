// Thin Gemini (generativelanguage) API client for LLM-authored prompts + artifact generation.
// Modeled on SpotifyClient (spotify/client.ts): a `fetch`-shaped function is injectable so tests
// run against @marquee/fake-gemini instead of the network; every request has an AbortController
// timeout. Auth is the `x-goog-api-key` header (never the URL — secrets don't belong in query
// strings). `generateText` drafts prompts, `generateImage` makes card art, `generateVideo` runs the
// Gemini Omni Flash image-to-video Interactions call for the visualizer clips.
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
   * Image-to-video model — Gemini Omni Flash (image-referenced, via the Interactions API), the model
   * the metaprompts target. Override via config; verify against your key's available models.
   */
  videoModel?: string;
  /** Per-request timeout (ms) for the fast calls (text/image). */
  timeoutMs?: number;
  /** Timeout (ms) for the video interaction — generation blocks server-side, so it's long (default 5 min). */
  videoTimeoutMs?: number;
  /** Sleep between file-download retries (injectable so tests run instantly). */
  sleep?: (ms: number) => Promise<void>;
  /** Interval between file-download retries when a generated clip isn't finalized yet (ms, default 10s). */
  videoPollIntervalMs?: number;
  /** Max download retries before giving up on a generated clip (default 60). */
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

/** A Gemini Omni Flash Interactions response: an ordered list of steps whose content holds the output. */
interface InteractionResponse {
  status?: string;
  error?: { message?: string };
  steps?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      mime_type?: string;
      /** Inline base64 video (small clips). */
      data?: string;
      /** File URI to download (large clips). */
      uri?: string;
    }>;
  }>;
}

export class GeminiClient {
  private readonly fetch: FetchLike;
  private readonly apiBase: string;
  private readonly textModel: string;
  private readonly imageModel: string;
  private readonly videoModel: string;
  private readonly timeoutMs: number;
  private readonly videoTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly videoPollIntervalMs: number;
  private readonly videoMaxPolls: number;

  constructor(private readonly opts: GeminiClientOptions) {
    this.fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.apiBase = opts.apiBase ?? API_BASE;
    this.textModel = opts.textModel ?? "gemini-flash-latest";
    this.imageModel = opts.imageModel ?? "gemini-3.1-flash-image";
    this.videoModel = opts.videoModel ?? "gemini-omni-flash-preview";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.videoTimeoutMs = opts.videoTimeoutMs ?? 300_000;
    this.sleep = opts.sleep ?? realSleep;
    this.videoPollIntervalMs = opts.videoPollIntervalMs ?? 10_000;
    this.videoMaxPolls = opts.videoMaxPolls ?? 60;
  }

  /**
   * fetch with an AbortController timeout — a hung connection rejects instead of hanging forever.
   * An optional external `signal` (a cancelled generation job, issue #57) aborts the same request;
   * an abort from it surfaces as a 499 "cancelled" so callers can tell it apart from a 504 timeout.
   */
  private async fetchT(
    input: string | URL,
    init: RequestInit = {},
    timeoutMs = this.timeoutMs,
    signal?: AbortSignal,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onExternalAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      return await this.fetch(input, { ...init, signal: ctrl.signal });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        if (signal?.aborted)
          throw new GeminiError("Gemini request cancelled", 499);
        throw new GeminiError(
          `Gemini request timed out after ${timeoutMs}ms`,
          504,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private generateContent(
    model: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<GenerateContentResponse> {
    return this.postJson<GenerateContentResponse>(
      `/v1beta/models/${model}:generateContent`,
      body,
      signal,
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
  async generateImage(
    prompt: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const data = await this.generateContent(
      model ?? this.imageModel,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      },
      signal,
    );
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

  private async postJson<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.fetchT(
      `${this.apiBase}${path}`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": this.opts.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      this.timeoutMs,
      signal,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GeminiError(
        `Gemini ${path} ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  /** Find the video part in an Interactions response (scan every step's content for a video item). */
  private static videoPart(
    data: InteractionResponse,
  ): { data?: string; uri?: string } | undefined {
    for (const step of data.steps ?? [])
      for (const c of step.content ?? [])
        if (c.type === "video" || c.mime_type?.startsWith("video/")) return c;
    return undefined;
  }

  /** Download a generated file URI, retrying while it's still being finalized (bounded). */
  private async downloadVideo(
    uri: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const url = uri.startsWith("http") ? uri : `${this.apiBase}/v1beta/${uri}`;
    for (let attempt = 0; ; attempt++) {
      const dl = await this.fetchT(
        url,
        { headers: { "x-goog-api-key": this.opts.apiKey } },
        this.videoTimeoutMs,
        signal,
      );
      if (dl.ok) return Buffer.from(await dl.arrayBuffer());
      // 404/403 can mean the file isn't ACTIVE yet — retry a bounded number of times.
      if (
        (dl.status === 404 || dl.status === 403) &&
        attempt < this.videoMaxPolls
      ) {
        await this.sleep(this.videoPollIntervalMs);
        continue;
      }
      throw new GeminiError(`Omni video download ${dl.status}`, dl.status);
    }
  }

  /**
   * Generate one image-to-video clip with Gemini Omni Flash (the Interactions API — a different
   * endpoint/shape from generateContent). Sends the prompt + a reference image (the album cover);
   * the model returns a video either inline (base64) or as a file URI to download. Throws GeminiError
   * on failure. The caller decides whether one failure among a batch is fatal.
   */
  async generateVideo(
    prompt: string,
    imageBytes: Buffer,
    imageMimeType = "image/jpeg",
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const res = await this.fetchT(
      `${this.apiBase}/v1beta/interactions`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": this.opts.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.videoModel,
          input: [
            {
              type: "image",
              data: imageBytes.toString("base64"),
              mime_type: imageMimeType,
            },
            { type: "text", text: prompt },
          ],
          generation_config: { video_config: { task: "image_to_video" } },
          response_format: {
            type: "video",
            aspect_ratio: "16:9",
            delivery: "uri",
          },
        }),
      },
      this.videoTimeoutMs, // generation blocks server-side for a while — allow a long timeout
      signal,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GeminiError(
        `Omni video ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        res.status,
      );
    }

    const data = (await res.json()) as InteractionResponse;
    if (data.error)
      throw new GeminiError(
        `Omni video failed: ${data.error.message ?? "unknown"}`,
      );
    const video = GeminiClient.videoPart(data);
    if (video?.data) return Buffer.from(video.data, "base64");
    if (video?.uri) return this.downloadVideo(video.uri, signal);
    throw new GeminiError("Omni video: no video in the response");
  }
}
