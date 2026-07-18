// Thin Gemini (generativelanguage) API client for LLM-authored prompts + artifact generation.
// Modeled on SpotifyClient (spotify/client.ts): a `fetch`-shaped function is injectable so tests
// run against @marquee/fake-gemini instead of the network; every request has an AbortController
// timeout. Auth is the `x-goog-api-key` header (never the URL — secrets don't belong in query
// strings). Text drafting uses `generateText`; card-art generation uses `generateImage`.
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
  /** Text/JSON model (default gemini-2.5-flash). */
  textModel?: string;
  /** Image model (default gemini-2.5-flash-image, aka "Nano Banana"). */
  imageModel?: string;
  /** Per-request timeout (ms). A hung connection must fail fast, not hang the request. */
  timeoutMs?: number;
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

export class GeminiClient {
  private readonly fetch: FetchLike;
  private readonly apiBase: string;
  private readonly textModel: string;
  private readonly imageModel: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GeminiClientOptions) {
    this.fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.apiBase = opts.apiBase ?? API_BASE;
    this.textModel = opts.textModel ?? "gemini-2.5-flash";
    this.imageModel = opts.imageModel ?? "gemini-2.5-flash-image";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
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

  private async generateContent(
    model: string,
    body: unknown,
  ): Promise<GenerateContentResponse> {
    const res = await this.fetchT(
      `${this.apiBase}/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": this.opts.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GeminiError(
        `Gemini ${model} ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        res.status,
      );
    }
    return (await res.json()) as GenerateContentResponse;
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
}
