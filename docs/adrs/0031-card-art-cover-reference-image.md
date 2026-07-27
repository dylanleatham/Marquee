# ADR 0031 — Card-art generation sends the album cover as a reference image, for cover-anchored prompts only

Status: accepted · Date: 2026-07-26 · Amends: [roadie-spec §7](../specs/roadie-spec.md) ("Prompt
drafting"), [curator-spec §Card art](../specs/curator-spec.md) · Builds on:
[ADR 0009](0009-llm-authored-grounded-prompts-via-gemini.md) (grounded LLM variant sets),
[ADR 0010](0010-auto-card-art-generation-candidate-set.md) (candidate-set generation),
[ADR 0021](0021-card-art-five-option-prompt-strategy.md) (five fixed-angle options),
[ADR 0013](0013-video-uses-gemini-omni-flash-interactions.md) (video already sends the cover)

## Context

Video generation has always sent the album cover as a reference image: `generateVideo` posts an
`{type: "image", data: <base64>}` input alongside the prompt to the Omni Flash Interactions endpoint
with `task: "image_to_video"` (ADR 0013). That is exactly what the maintainer does by hand in Google
Flow — attach the sleeve so the output is anchored to it rather than reinvented.

**Card-art generation did not.** `generateImage` built `contents: [{role: "user", parts: [{text}]}]`
and nothing else. The `generateContent` endpoint accepts image inputs on the same `parts` array
(`inlineData: { mimeType, data }`) — the mechanism Nano Banana uses for reference-guided generation —
so the capability was there and simply unused.

The gap bit hardest where it was least acceptable. ADR 0021's Option 1 is **"The Cover Reimagining:
a direct landscape adaptation of the primary, iconic front cover artwork, emphasizing its exact color
palette, key subject, and authentic visual medium."** With no cover attached, the model was
reconstructing the sleeve from whatever it associates with the album's name — which drifts, and
drifts worst for albums whose art is less famous than their title.

The obvious fix — attach the cover to every card-art call — is wrong. ADR 0021 chose five
**deliberately complementary** angles: Options 3–5 (Visual Artist Provenance, Live Performance Era,
Album Lore & Narrative Artifact) exist precisely to depart from the sleeve and depict something else
in the album's world. Feeding them the cover would pull the whole set back toward one image and
collapse the spread the five-option strategy exists to produce.

## Decision

**The album cover is sent as a reference image on card-art generation, but only for the prompts that
re-render the sleeve. The drafter decides which those are.**

1. **`PromptVariant.coverAnchored?: boolean`** (`roadie/prompts.ts`). Set when a variant directly
   re-renders or adapts the album's real front cover. Optional: absent on template drafts and on any
   draft persisted before this ADR, and absence reads as **not anchored** — i.e. the pre-ADR
   text-only behavior, which is the safe default.

2. **The drafter asks for it — on card art only.** The variants schema (`gemini/draft.ts`) becomes a
   function of prompt type: for `cardArt` it requires a `coverAnchored` boolean and the user-turn
   override instructs "true only when the prompt directly re-renders the actual front cover; false
   when it deliberately departs — _even if it borrows the cover's palette or medium_." For `video`
   both the field and the instruction are omitted: every video prompt animates the cover by
   construction, so the flag would be uniformly true and nothing consumes it. `parseVariants` treats
   only an explicit `true` as anchored; `false` and a missing field both yield `undefined`.

   The instruction goes in the **user turn**, not the metaprompt. `CARD_ART_METAPROMPT` and its
   canonical copy in `docs/prompts/` are the manual paste-into-a-chat workflow and are held
   byte-identical by the drift-guard test; the drafter already overrides output format there (ADR
   0021). Nothing about the five options' _content_ changed, so the metaprompts are untouched.

3. **`generateImage(prompt, opts)` takes an optional reference** (`gemini/client.ts`). The signature
   moves from positional `(prompt, model?, signal?)` to an options object — a third optional
   positional would have made every call site pass `undefined` twice. When `reference` is present the
   image part is emitted **before** the text part: Gemini reads parts in order, so the image reads as
   the subject the trailing text then instructs on. Mime type defaults to `image/jpeg`.

   `generateVideo` moves to the same shape — `(prompt, reference: ReferenceImage, { signal })`
   instead of `(prompt, imageBytes, imageMimeType?, signal?)` — so the client's two
   reference-carrying calls read alike. The reference is **required** there and optional on
   `generateImage`, which is the one real asymmetry and mirrors point 5 below.

4. **The actions attach it selectively.** A single `coverReference(deps, asset)` helper is now the
   one place a cover is read for an LLM call, and `referenceFor(variant, cover)` hands it only to
   `coverAnchored` variants. Both the whole-set (`generateCardArtSet`) and per-prompt
   (`generateCardArtOne`) paths use it.

   **Video reads the cover through the same helper.** Previously `generateVideoClip` passed
   `undefined` for the mime type, taking `generateVideo`'s `image/jpeg` default regardless of the
   actual file — so a PNG artwork override was mislabelled to Gemini. Sharing one helper fixes that
   and removes a divergence where two call sites derived the same fact differently. `.jpg`/`.jpeg`
   are deliberately absent from the extension map: they fall through to the same `image/jpeg`
   default, which is what covers overwhelmingly are.

5. **A missing cover is not an error.** Unlike video — where `ensureVideoGenerable` throws "album has
   no cover art to animate" because image-to-video is meaningless without one — card art is only
   _improved_ by the reference. With no artwork on disk, anchored variants fall back to text-only and
   generation proceeds.

## Consequences

- Option 1 candidates should now track the real sleeve closely instead of an approximation of it,
  while Options 2–5 are byte-for-byte unaffected in how they're generated.
- **Request size grows** for anchored calls: one cover (typically a few hundred KB base64-encoded) per
  anchored variant. With one anchored option in five, a whole-set run sends it once, not five times —
  a further reason the selective design beats attaching it everywhere.
- `coverAnchored` is **advisory, model-authored metadata**. A drafter that mislabels an option changes
  which prompts get the reference; it cannot break generation, since both branches are valid calls.
- Older persisted drafts keep working untouched and simply generate as they do today. There is no
  migration: the field is additive and optional.
- Video keeps sending the cover **unconditionally** — every video prompt animates it by construction,
  so the per-variant selectivity has no use there. Video's only behavioral change is the mime-type fix
  above: a PNG or WebP cover is now labelled correctly instead of always claiming `image/jpeg`.
- **Spec reconciliation:** roadie-spec §7 (the drafter now emits `coverAnchored`) and curator-spec
  §Card art (generation attaches the cover for anchored prompts) are updated in this change, per
  "keep the specs honest."
