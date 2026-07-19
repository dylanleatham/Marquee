// Fake Gemini generativelanguage API for tests — a `fetch`-compatible function backed by canned
// responses. Fakes at the HTTP boundary (testing-strategy §3.1): the client's real request-building,
// auth header, JSON parsing, grounding/schema selection, and error handling all run against it.
// Rule of thumb: a fake needs its own tests.
import { Buffer } from "node:buffer";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** One captured request, so tests can assert which mode the client used. */
export interface FakeGeminiCall {
  model: string;
  /** Google Search grounding requested (tools present). */
  grounded: boolean;
  /** Structured-output requested (responseSchema present). */
  structured: boolean;
  /** For Omni video: which phase this call was. */
  video?: "interaction" | "download";
  body: {
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
    systemInstruction?: { parts?: Array<{ text?: string }> };
    tools?: unknown[];
    generationConfig?: { responseSchema?: unknown; temperature?: number };
    /** Omni Interactions request. */
    model?: string;
    input?: Array<{ type?: string; text?: string; mime_type?: string }>;
  };
}

export interface FakeGeminiOptions {
  /** Text returned for grounded (research) calls. */
  research?: string;
  /** Object returned (JSON-stringified) for structured (responseSchema) calls. */
  json?: unknown;
  /** Base64 data returned as inlineData for image-model calls. */
  imageBase64?: string;
  /** Plain text for un-grounded, un-structured calls. */
  text?: string;
  /** Force every call to fail with this HTTP status (e.g. 429, 500). */
  failStatus?: number;
  /** Bytes served for a generated Omni video (default "MP4"). */
  videoBytes?: string;
  /** Return the video inline (base64 `data`) instead of a `uri` to download (small-clip path). */
  videoInline?: boolean;
  /** If set, the Omni interaction completes with this error message instead of a video. */
  videoError?: string;
}

export interface FakeGemini {
  fetch: FetchLike;
  calls(): FakeGeminiCall[];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function header(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const h = init?.headers;
  if (!h) return undefined;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const rec = h as Record<string, string>;
  return rec[name] ?? rec[name.toLowerCase()] ?? undefined;
}

const textResponse = (text: string) =>
  json({ candidates: [{ content: { parts: [{ text }] } }] });

export function createFakeGemini(opts: FakeGeminiOptions = {}): FakeGemini {
  const calls: FakeGeminiCall[] = [];
  let interactionCount = 0;

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname;

    if (!header(init, "x-goog-api-key"))
      return json({ error: { code: 401, message: "missing api key" } }, 401);

    // --- Gemini Omni Flash video: the Interactions API (POST → steps[] with a video part) ---
    if (path === "/v1beta/interactions") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({
        model: body.model,
        grounded: false,
        structured: false,
        video: "interaction",
        body,
      });
      if (opts.failStatus)
        return json({ error: { code: opts.failStatus } }, opts.failStatus);
      if (opts.videoError)
        return json({ status: "failed", error: { message: opts.videoError } });
      const bytes = Buffer.from(opts.videoBytes ?? "MP4");
      const videoContent = opts.videoInline
        ? {
            type: "video",
            mime_type: "video/mp4",
            data: bytes.toString("base64"),
          }
        : {
            type: "video",
            mime_type: "video/mp4",
            uri: `${url.origin}/download/omni-${++interactionCount}.mp4`,
          };
      return json({
        status: "completed",
        steps: [
          { type: "user_input", content: [] },
          { type: "model_output", content: [videoContent] },
        ],
      });
    }

    if (path.startsWith("/download/")) {
      calls.push({
        model: "",
        grounded: false,
        structured: false,
        video: "download",
        body: {},
      });
      return new Response(Buffer.from(opts.videoBytes ?? "MP4"), {
        headers: { "content-type": "video/mp4" },
      });
    }

    const match = path.match(/\/v1beta\/models\/([^:]+):generateContent$/);
    if (!match) return json({ error: { message: "unhandled path" } }, 404);

    const model = match[1]!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const grounded = Array.isArray(body.tools) && body.tools.length > 0;
    const structured = Boolean(body.generationConfig?.responseSchema);
    calls.push({ model, grounded, structured, body });

    if (opts.failStatus)
      return json(
        { error: { code: opts.failStatus, message: "forced failure" } },
        opts.failStatus,
      );

    if (model.includes("image"))
      return json({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: opts.imageBase64 ?? "AQID" } }],
            },
          },
        ],
      });

    if (structured) return textResponse(JSON.stringify(opts.json ?? {}));
    if (grounded) return textResponse(opts.research ?? "grounded research");
    return textResponse(opts.text ?? "plain text");
  };

  return { fetch, calls: () => calls };
}
