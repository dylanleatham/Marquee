// The interactive onboarding sections of the album detail (step 7): prompt (copy / regenerate),
// video (upload / player / detach), card art, and the preview checkpoint. Each action goes through
// the `run` helper the page provides, which handles errors + re-polls the album.
import { useEffect, useRef, useState } from "react";
import {
  api,
  activePromptText,
  videoUrl,
  thumbnailUrl,
  videoClipUrl,
  videoClipThumbnailUrl,
  videoClipDownloadUrl,
  cardArtUrl,
  cardArtPrintUrl,
  cardArtCandidateUrl,
  VIDEO_TEMPLATES,
  CARD_ART_TEMPLATES,
  type AlbumAsset,
  type DraftedPrompt,
  type PromptType,
} from "../api";
import { useGenerationJob, type GenerationJobHook } from "../hooks";

/** The generate button's label reflects live job progress ("Generating 3/5…"). */
function generateLabel(
  gen: GenerationJobHook,
  idle: string,
  regen: string,
  hasSet: boolean,
): string {
  if (gen.status === "running")
    return gen.progress && gen.progress.total
      ? `Generating ${gen.progress.done}/${gen.progress.total}…`
      : "Generating…";
  return hasSet ? regen : idle;
}

/** Wrap an action with the page's error handling + refresh. Returns while the action runs. */
export type Run = (fn: () => Promise<unknown>) => Promise<void>;

/** onChange handler that hands the chosen file to `onFile` and resets the input for re-picking. */
function pickFile(onFile: (f: File) => void) {
  return (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onFile(f);
    e.target.value = "";
  };
}

/**
 * A drafted prompt. Grounded LLM drafts carry several variants (the human picks one); template
 * drafts carry a single one. Copy hands off the active variant; the template <select> reruns the
 * deterministic template; "Regenerate with AI" re-runs the grounded LLM drafter.
 */
export function PromptBlock({
  curatorId,
  type,
  prompt,
  run,
}: {
  curatorId: string;
  type: PromptType;
  prompt: DraftedPrompt;
  run: Run;
}) {
  const [copied, setCopied] = useState(false);
  const templates = type === "video" ? VIDEO_TEMPLATES : CARD_ART_TEMPLATES;
  const defaultTemplate = templates[0];
  const isAI = prompt.generator === "gemini";
  const multiple = prompt.variants.length > 1;
  // Copying the prompt *is* the signal (ADR 0005) — no second "Mark copied" click. The server
  // decides what that means: for the video prompt at review it advances to awaiting_video; for
  // card art it's bookkeeping. The clipboard write is best-effort on purpose: a denied permission
  // or unfocused document must not strand the album at review, and the text is on screen to take
  // by hand either way. The click is the signal, not the clipboard.
  const copy = async () => {
    await navigator.clipboard
      .writeText(activePromptText(prompt))
      .catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    run(() => api.markPromptCopied(curatorId, type));
  };
  return (
    <div className="prompt">
      <div className="prompt__head">
        <span
          className={`badge ${isAI ? "badge--ai" : "badge--template"}`}
          title={
            isAI
              ? "Grounded, LLM-authored — references real details of this album"
              : "Deterministic template fallback"
          }
        >
          {isAI ? "AI · grounded" : "Template"}
        </span>
        <button
          className="btn btn--sm"
          onClick={() => run(() => api.regeneratePromptAI(curatorId, type))}
          title="Re-draft with Gemini, grounded in real album details"
        >
          Regenerate with AI
        </button>
        <select
          className="select"
          value={prompt.template ?? defaultTemplate}
          aria-label="prompt template"
          onChange={(e) =>
            run(() => api.redraftPrompt(curatorId, type, e.target.value))
          }
        >
          {templates.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button className="btn btn--primary btn--sm" onClick={copy}>
          {copied ? "Copied ✓" : "Copy prompt"}
        </button>
      </div>
      {multiple && (
        <div
          className="prompt__variants"
          role="radiogroup"
          aria-label="prompt variants"
        >
          {prompt.variants.map((v, i) => (
            <button
              key={i}
              role="radio"
              aria-checked={i === prompt.selectedIndex}
              className={`chip ${i === prompt.selectedIndex ? "chip--on" : ""}`}
              onClick={() =>
                run(() => api.selectPromptVariant(curatorId, type, i))
              }
              title={v.text}
            >
              {i + 1}. {v.nudge || `Variant ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <pre className="prompt__text">{activePromptText(prompt)}</pre>
    </div>
  );
}

/** Video: a drop zone until attached (open from review onward), then an inline player + replace/detach. */
export function VideoSection({
  curatorId,
  asset,
  run,
  refresh = () => {},
  canGenerate: genEnabled = false,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
  /** Pull fresh album data (used the moment a generation job finishes). Defaults to a no-op. */
  refresh?: () => void;
  /** API video generation is opt-in (Settings); off → the "Generate clips" button is hidden. */
  canGenerate?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const state = asset.roadie.state;
  // Mirrors the server's VIDEO_ATTACHABLE (albums/actions.ts): attachable from review onward, so
  // a video you already have doesn't need the prompt touched first (issue #11 / ADR 0005).
  const canUpload =
    state === "awaiting_review" ||
    state === "awaiting_video" ||
    state === "awaiting_preview";
  const upload = (f: File) => {
    const form = new FormData();
    form.set("file", f);
    return run(() => api.uploadVideo(curatorId, form));
  };

  const clips = asset.videoClips ?? [];
  // Clips are generated from the album cover, so a video prompt + artwork must exist — and API
  // generation must be enabled in Settings (genEnabled). Off → no button; you copy the prompt.
  const canGenerate =
    genEnabled && Boolean(asset.promptDrafts?.video) && Boolean(asset.artwork);
  // Generation runs as a background job (issue #30); the hook polls it and refreshes on completion.
  const gen = useGenerationJob(
    curatorId,
    "video",
    () => api.generateVideoSet(curatorId),
    refresh,
    canGenerate,
  );
  const generating = gen.status === "running";

  return (
    <div className="video">
      {canGenerate && (
        <div className="row-actions">
          <button
            className="btn btn--sm"
            onClick={gen.start}
            disabled={generating}
            title="Generate short clips from the album cover with Gemini, one per prompt variant"
          >
            {generateLabel(
              gen,
              "Generate clips with AI",
              "Regenerate clips with AI",
              clips.length > 0,
            )}
          </button>
          {clips.length > 0 && !generating && (
            <span className="muted">
              Download the clips and splice them into one loop, then upload the
              result below.
            </span>
          )}
        </div>
      )}
      {gen.error && <div className="banner banner--error">{gen.error}</div>}

      {clips.length > 0 && (
        <div className="video__clips">
          {clips.map((c) => (
            <div key={c.index} className="video__clip">
              <video
                className="video__clip-vid"
                src={videoClipUrl(curatorId, c.index)}
                poster={videoClipThumbnailUrl(curatorId, c.index)}
                controls
                muted
                loop
                preload="metadata"
              />
              <div className="video__clip-row">
                <span className="muted">
                  {c.nudge || `Clip ${c.index + 1}`}
                  {c.durationSec ? ` · ${c.durationSec}s` : ""}
                </span>
                <a
                  className="btn btn--sm"
                  href={videoClipDownloadUrl(curatorId, c.index)}
                  download
                >
                  Download
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      {asset.visualizer ? (
        <div>
          <video
            className="media-frame"
            src={videoUrl(curatorId)}
            poster={thumbnailUrl(curatorId)}
            controls
            loop
            muted
          />
          <div className="row-actions">
            <span className="muted">
              {asset.visualizer.originalFilename}
              {asset.visualizer.resolution
                ? ` · ${asset.visualizer.resolution}`
                : ""}
            </span>
            <button
              className="btn btn--sm"
              onClick={() => fileRef.current?.click()}
            >
              Replace
            </button>
            <button
              className="btn btn--sm btn--danger"
              onClick={() => run(() => api.detachVideo(curatorId, true))}
            >
              Detach
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="video/mp4"
              hidden
              onChange={pickFile(upload)}
            />
          </div>
        </div>
      ) : (
        <label
          className={`dropzone ${canUpload ? "" : "dropzone--disabled"}`}
          onDragOver={(e) => canUpload && e.preventDefault()}
          onDrop={(e) => {
            if (!canUpload) return;
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) upload(f);
          }}
        >
          <input
            type="file"
            accept="video/mp4"
            hidden
            disabled={!canUpload}
            onChange={pickFile(upload)}
          />
          {canUpload
            ? "Drop an H.264 MP4 here, or click to choose"
            : "Available once Roadie has the album ready for review"}
        </label>
      )}
    </div>
  );
}

/**
 * Card art: independent of the state machine — attach any time, even after verified. When a
 * card-art prompt is drafted you can generate a set of AI candidates (Nano Banana) and click one to
 * use it; a manual PNG/JPEG upload remains as the override.
 */
export function CardArtSection({
  curatorId,
  asset,
  run,
  refresh = () => {},
  canGenerate: genEnabled = false,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
  /** Pull fresh album data (used the moment a generation job finishes). Defaults to a no-op. */
  refresh?: () => void;
  /** API card-art generation is opt-in (Settings); off → the "Generate options" button is hidden. */
  canGenerate?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = (f: File) => {
    const form = new FormData();
    form.set("file", f);
    return run(() => api.uploadCardArt(curatorId, form));
  };

  const candidates = asset.cardArtCandidates ?? [];
  const canGenerate = genEnabled && Boolean(asset.promptDrafts?.cardArt);
  // Generation runs as a background job (issue #30); the hook polls it and refreshes on completion.
  const gen = useGenerationJob(
    curatorId,
    "cardArt",
    () => api.generateCardArtSet(curatorId),
    refresh,
    canGenerate,
  );
  const generating = gen.status === "running";

  return (
    <div className="cardart">
      {canGenerate && (
        <div className="row-actions">
          <button
            className="btn btn--sm"
            onClick={gen.start}
            disabled={generating}
            title="Generate a set of card-art options with Gemini, one per prompt variant"
          >
            {generateLabel(
              gen,
              "Generate options with AI",
              "Regenerate options with AI",
              candidates.length > 0,
            )}
          </button>
          {candidates.length > 0 && !generating && (
            <span className="muted">
              Click an option to use it as the card.
            </span>
          )}
        </div>
      )}
      {gen.error && <div className="banner banner--error">{gen.error}</div>}

      {candidates.length > 0 && (
        <div className="cardart__gallery">
          {candidates.map((c) => (
            <button
              key={c.index}
              className="cardart__candidate"
              title={c.nudge || `Option ${c.index + 1}`}
              onClick={() => run(() => api.selectCardArt(curatorId, c.index))}
            >
              <img
                src={cardArtCandidateUrl(curatorId, c.index)}
                alt={c.nudge || `option ${c.index + 1}`}
              />
              <span>{c.nudge || `Option ${c.index + 1}`}</span>
            </button>
          ))}
        </div>
      )}

      {asset.cardArt ? (
        <div>
          <img
            className="media-frame media-frame--art"
            src={`${cardArtUrl(curatorId)}?v=${asset.cardArt.attachedAt}`}
            alt="card art"
          />
          <div className="row-actions">
            <span className="muted">
              {asset.cardArt.originalFilename}
              {asset.cardArt.resolution ? ` · ${asset.cardArt.resolution}` : ""}
            </span>
            <a
              className="btn btn--sm"
              href={cardArtPrintUrl(curatorId)}
              download
            >
              Download print
            </a>
            <button
              className="btn btn--sm"
              onClick={() => fileRef.current?.click()}
            >
              Replace
            </button>
            <button
              className="btn btn--sm btn--danger"
              onClick={() => run(() => api.detachCardArt(curatorId, true))}
            >
              Detach
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              hidden
              onChange={pickFile(upload)}
            />
          </div>
        </div>
      ) : (
        <label
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) upload(f);
          }}
        >
          <input
            type="file"
            accept="image/png,image/jpeg"
            hidden
            onChange={pickFile(upload)}
          />
          Drop a PNG/JPEG card image here, or click to choose
        </label>
      )}
    </div>
  );
}

/** The palette animating alongside the video, driven by the pattern's hold time (crossfade). */
function PaletteStage({
  colors,
  holdMs,
}: {
  colors: Array<{ hex: string }>;
  holdMs: number;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (colors.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % colors.length), holdMs);
    return () => clearInterval(t);
  }, [colors.length, holdMs]);
  return (
    <div
      className="palette-stage"
      style={{
        background: colors[i]?.hex ?? "#000",
        transition: `background ${Math.min(holdMs / 2, 4000)}ms ease-in-out`,
      }}
    />
  );
}

/** The preview checkpoint (curator-spec §10): video + palette, approve or step back to iterate. */
export function PreviewSection({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
}) {
  const colors = asset.palette?.colors ?? [];
  const holdMs = Number(asset.pattern?.params?.holdMs) || 3000;
  return (
    <div className="preview">
      <div className="preview__stage">
        <PaletteStage colors={colors} holdMs={holdMs} />
        <video
          className="preview__video"
          src={videoUrl(curatorId)}
          poster={thumbnailUrl(curatorId)}
          controls
          loop
          autoPlay
          muted
        />
      </div>
      <div className="row-actions">
        <button
          className="btn btn--primary"
          onClick={() => run(() => api.approvePreview(curatorId))}
        >
          Looks good →
        </button>
        <button
          className="btn"
          onClick={() =>
            run(() => api.rejectPreview(curatorId, "awaiting_video"))
          }
        >
          Something's off — back to video
        </button>
        <button
          className="btn btn--ghost"
          onClick={() =>
            run(() => api.rejectPreview(curatorId, "awaiting_review"))
          }
        >
          Back to palette
        </button>
      </div>
    </div>
  );
}
