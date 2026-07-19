# ADR 0013 — Video generation uses Gemini Omni Flash (Interactions API), not Veo

Status: accepted · Date: 2026-07-19 · Supersedes the mechanism in [ADR 0011](0011-auto-generate-visualizer-clips.md) (the candidate-set/download shape stands; the _API_ changes) · Closes: [#36](https://github.com/dylanleatham/Marquee/issues/36)

## Context

ADR 0011 built visualizer-clip generation against **Veo** as a long-running operation:
`POST models/veo-*:predictLongRunning` → poll the operation → download the MP4. That was the best
guess when the code was written against a fake.

Live-key testing surfaced two facts:

1. **Veo isn't what this key exposes.** `GET /v1beta/models` on a real key lists no `veo-*` model,
   but does list **`gemini-omni-flash-preview`** — the image-referenced "Omni" model the metaprompts
   already target ("Gemini Omni… from image references").
2. **Omni video uses a different API.** It runs on the new **Interactions API**
   (`POST /v1beta/interactions`), with a flat `{ model, input[] }` request and a `steps[]` response —
   _not_ `generateContent` and _not_ the Veo `predictLongRunning` LRO. So the ADR 0011 client code
   didn't just have a wrong slug; it targeted the wrong endpoint and shapes entirely.

Bonus: Omni Flash is **~$0.10/sec** (~$1 per 10-second clip) versus Veo's ~$0.75/sec — much cheaper,
which softens (but doesn't remove) the cost rationale for keeping generation opt-in (ADR 0012).

## Decision

**`GeminiClient.generateVideo` targets Gemini Omni Flash via the Interactions API.** Everything
around it — the 5-clip candidate set, partial-keep, deliver-for-download, opt-in gating — is
unchanged (ADR 0011/0012); only the single client method's request/response and the default slug
change.

- **Request:** `POST /v1beta/interactions` with
  `{ model: <videoModel>, input: [ {type:"image", data:<b64 cover>, mime_type}, {type:"text", text:<prompt>} ], generation_config:{ video_config:{ task:"image_to_video" } }, response_format:{ type:"video", aspect_ratio:"16:9", delivery:"uri" } }`.
- **Response:** scan `steps[].content[]` for the `video` part; use inline `data` (base64) if present,
  else download the `uri` (bounded retry while the file finalizes).
- **Default `videoModel` → `gemini-omni-flash-preview`** (overridable via `config.toml [gemini]
video_model` / `GEMINI_VIDEO_MODEL`, from [the model-slug fix](../../packages/curator/src/config.ts)).
- The interaction blocks server-side during generation, so it gets a long timeout (`videoTimeoutMs`,
  default 5 min); the old poll-interval/max-polls now bound the _file-download_ retry instead.

## Consequences

- ADR 0011's "long-running operation, poll the op" description is superseded — see the client for the
  actual flow. The candidate-set/download/splice-deferred decisions there still hold.
- **Not yet verified against a live generation.** The Interactions request/response shape is from
  Google's docs, not a real call from this repo. The parser is deliberately tolerant (inline-or-uri,
  scan all steps). If a live run reveals a shape difference, it's a localized fix in `generateVideo`
  - the fake.
- Cost drops ~7× vs Veo; generation stays opt-in regardless (ADR 0012).
