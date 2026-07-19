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
  /** For the video long-running operation: which phase this call was. */
  video?: "start" | "poll" | "download";
  body: {
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
    systemInstruction?: { parts?: Array<{ text?: string }> };
    tools?: unknown[];
    generationConfig?: { responseSchema?: unknown; temperature?: number };
    instances?: Array<{ prompt?: string; image?: { mimeType?: string } }>;
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
  /** Bytes served for a generated video download (default "MP4"). */
  videoBytes?: string;
  /** Not-done polls to return before an operation reports done (default 0 → done on first poll). */
  videoPollsUntilDone?: number;
  /** If set, the video operation completes with this error message instead of a result. */
  videoOpError?: string;
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
  let startCount = 0;
  const pollCounts = new Map<string, number>();

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname;

    if (!header(init, "x-goog-api-key"))
      return json({ error: { code: 401, message: "missing api key" } }, 401);

    // --- Video long-running operation (Veo/"Omni"): start → poll → download ---
    const startMatch = path.match(
      /\/v1beta\/models\/([^:]+):predictLongRunning$/,
    );
    if (startMatch) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({
        model: startMatch[1]!,
        grounded: false,
        structured: false,
        video: "start",
        body,
      });
      if (opts.failStatus)
        return json({ error: { code: opts.failStatus } }, opts.failStatus);
      const name = `operations/vid-${++startCount}`;
      pollCounts.set(name, 0);
      return json({ name });
    }

    const opMatch = path.match(/\/v1beta\/(operations\/[^/]+)$/);
    if (opMatch) {
      const name = opMatch[1]!;
      calls.push({
        model: "",
        grounded: false,
        structured: false,
        video: "poll",
        body: {},
      });
      const n = (pollCounts.get(name) ?? 0) + 1;
      pollCounts.set(name, n);
      if (n <= (opts.videoPollsUntilDone ?? 0))
        return json({ name, done: false });
      if (opts.videoOpError)
        return json({
          name,
          done: true,
          error: { message: opts.videoOpError },
        });
      const id = name.split("/")[1];
      return json({
        name,
        done: true,
        response: {
          generatedVideos: [
            { video: { uri: `${url.origin}/download/${id}.mp4` } },
          ],
        },
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
