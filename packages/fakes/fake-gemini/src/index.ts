// Fake Gemini generativelanguage API for tests — a `fetch`-compatible function backed by canned
// responses. Fakes at the HTTP boundary (testing-strategy §3.1): the client's real request-building,
// auth header, JSON parsing, grounding/schema selection, and error handling all run against it.
// Rule of thumb: a fake needs its own tests.

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
  body: {
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
    systemInstruction?: { parts?: Array<{ text?: string }> };
    tools?: unknown[];
    generationConfig?: { responseSchema?: unknown; temperature?: number };
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

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const match = url.pathname.match(
      /\/v1beta\/models\/([^:]+):generateContent$/,
    );
    if (!match) return json({ error: { message: "unhandled path" } }, 404);

    if (!header(init, "x-goog-api-key"))
      return json({ error: { code: 401, message: "missing api key" } }, 401);

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
