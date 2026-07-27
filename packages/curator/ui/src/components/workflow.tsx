// The interactive onboarding sections of the album detail (step 7): prompt (copy / regenerate),
// video (upload / player / detach), card art, and the preview checkpoint. Each action goes through
// the `run` helper the page provides, which handles errors + re-polls the album.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
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
  type VideoClip,
} from "../api";
import { useGenerationJob, usePending, type GenerationJobHook } from "../hooks";
import { AsyncButton, Spinner } from "./common";

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

/** Shared prompt header: provenance badge, "Regenerate with AI", and the template style <select>. */
function PromptHead({
  curatorId,
  type,
  prompt,
  run,
  children,
}: {
  curatorId: string;
  type: PromptType;
  prompt: DraftedPrompt;
  run: Run;
  /** Type-specific trailing control(s) — e.g. the video "Copy prompt" button. */
  children?: React.ReactNode;
}) {
  // A template change re-runs the deterministic drafter server-side; disable the <select> (not a
  // button, so no AsyncButton) while that round-trips so it can't be spammed (issue #62).
  const [redrafting, wrapRedraft] = usePending();
  const templates = type === "video" ? VIDEO_TEMPLATES : CARD_ART_TEMPLATES;
  const defaultTemplate = templates[0];
  const isAI = prompt.generator === "gemini";
  return (
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
      <AsyncButton
        className="btn btn--sm"
        onClick={() => run(() => api.regeneratePromptAI(curatorId, type))}
        pendingLabel="Regenerating…"
        title="Re-draft with Gemini, grounded in real album details"
      >
        Regenerate with AI
      </AsyncButton>
      <select
        className="select"
        value={prompt.template ?? defaultTemplate}
        aria-label="prompt template"
        disabled={redrafting}
        onChange={(e) =>
          wrapRedraft(() =>
            run(() => api.redraftPrompt(curatorId, type, e.target.value)),
          )
        }
      >
        {templates.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {children}
    </div>
  );
}

/** Best-effort clipboard write — a denied permission / unfocused doc must never strand the album. */
const writeClipboard = (text: string) =>
  navigator.clipboard.writeText(text).catch(() => {});

/**
 * Per-prompt clip generation (ADR 0022): a clip is a multi-minute Omni call, so each button drives
 * its own background job (keyed on the prompt index), polled for progress and re-attached on reload.
 * The generated clip lands in the clip gallery + splice controls below (VideoSection).
 */
function VideoClipGenerateButton({
  curatorId,
  index,
  refresh,
}: {
  curatorId: string;
  index: number;
  refresh: () => void;
}) {
  const gen = useGenerationJob(
    curatorId,
    "video",
    () => api.generateVideoOne(curatorId, index),
    refresh,
    true,
    index,
  );
  const generating = gen.status === "running";
  return (
    <>
      <button
        className="btn btn--sm"
        onClick={gen.start}
        disabled={generating}
        aria-busy={generating || undefined}
        title="Generate a clip from this prompt with Gemini (Omni)"
      >
        {generating && <Spinner />}{" "}
        {generating ? "Generating…" : "Generate clip"}
      </button>
      {gen.error && <span className="banner banner--error">{gen.error}</span>}
    </>
  );
}

/**
 * The prompt set (ADR 0021/0022): every drafted prompt surfaced in full, each with its own Copy (to
 * take to Google Flow / Midjourney by hand) and — when API generation is enabled — its own generate
 * button (`renderGenerate`), which runs that one prompt and drops the result into the candidate/clip
 * gallery below. Copying records the copy server-side (card art: bookkeeping; video: advances the
 * album to awaiting_video at review, ADR 0005) — the click is the signal, the clipboard is best-effort.
 */
function PromptList({
  curatorId,
  type,
  prompt,
  run,
  fallbackLabel,
  renderGenerate,
}: {
  curatorId: string;
  type: PromptType;
  prompt: DraftedPrompt;
  run: Run;
  /** Label for a variant whose nudge is empty (e.g. "Option 3", "Prompt 3"). */
  fallbackLabel: (i: number) => string;
  /** Optional per-prompt generate control (omitted when API generation is off). */
  renderGenerate?: (i: number) => React.ReactNode;
}) {
  // Which prompt's Copy most recently fired, for the transient "Copied ✓" affordance.
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const copy = (i: number, text: string) => {
    void writeClipboard(text);
    setCopiedIndex(i);
    setTimeout(() => setCopiedIndex((cur) => (cur === i ? null : cur)), 1500);
    run(() => api.markPromptCopied(curatorId, type));
  };
  return (
    <div className="prompt">
      <PromptHead curatorId={curatorId} type={type} prompt={prompt} run={run} />
      <ol className="prompt__list">
        {prompt.variants.map((v, i) => (
          <li key={i} className="prompt__item">
            <div className="prompt__item-head">
              <span className="chip chip--static">
                {i + 1}. {v.nudge || fallbackLabel(i)}
              </span>
              <button
                className="btn btn--primary btn--sm"
                onClick={() => copy(i, v.text)}
              >
                {copiedIndex === i ? "Copied ✓" : "Copy"}
              </button>
              {renderGenerate?.(i)}
            </div>
            <pre className="prompt__text">{v.text}</pre>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * A drafted prompt set — every variant surfaced with its own Copy and, when API generation is on, its
 * own generate button: card art → one Nano Banana image per prompt (synchronous, into the candidate
 * gallery); video → one Omni clip per prompt (background job, into the clip gallery + splice). The
 * template <select> reruns the deterministic template; "Regenerate with AI" re-runs the LLM drafter.
 */
export function PromptBlock({
  curatorId,
  type,
  prompt,
  run,
  canGenerate = false,
  refresh = () => {},
}: {
  curatorId: string;
  type: PromptType;
  prompt: DraftedPrompt;
  run: Run;
  /** Whether the per-prompt generate buttons are shown (API generation is opt-in in Settings). */
  canGenerate?: boolean;
  /** Pull fresh album data once a clip generation finishes (video). Defaults to a no-op. */
  refresh?: () => void;
}) {
  const renderGenerate = !canGenerate
    ? undefined
    : type === "cardArt"
      ? (i: number) => (
          <AsyncButton
            className="btn btn--sm"
            onClick={() => run(() => api.generateCardArtOne(curatorId, i))}
            pendingLabel="Generating…"
            title="Generate a card-art option from this prompt with Gemini (Nano Banana)"
          >
            Generate art
          </AsyncButton>
        )
      : (i: number) => (
          <VideoClipGenerateButton
            curatorId={curatorId}
            index={i}
            refresh={refresh}
          />
        );
  const fallbackLabel = (i: number) =>
    type === "cardArt" ? `Option ${i + 1}` : `Prompt ${i + 1}`;
  return (
    <PromptList
      curatorId={curatorId}
      type={type}
      prompt={prompt}
      run={run}
      fallbackLabel={fallbackLabel}
      renderGenerate={renderGenerate}
    />
  );
}

/**
 * A prompt slot: the drafted prompts, or the button that asks for them (ADR 0027).
 *
 * Drafting is no longer pre-computed during onboarding, because two Gemini calls per album were
 * being spent on prompts that were often never opened. So the slot has three shapes, in priority
 * order:
 *
 *  1. **Artifact already attached** — lead with that fact and demote drafting to a secondary action.
 *     This is the case ADR 0027 exists for: you already have the video, so don't pay for prompts.
 *  2. **Prompts drafted** — show them.
 *  3. **Neither** — a single Draft button, labelled with what it will cost.
 */
export function PromptSlot({
  curatorId,
  type,
  prompt,
  hasArtifact,
  run,
  canGenerate = false,
  refresh = () => {},
}: {
  curatorId: string;
  type: PromptType;
  prompt?: DraftedPrompt;
  /** Whether the artifact this prompt would produce already exists (visualizer / card art). */
  hasArtifact: boolean;
  run: Run;
  canGenerate?: boolean;
  refresh?: () => void;
}) {
  const noun = type === "cardArt" ? "card-art" : "video";

  // Once prompts exist, PromptBlock owns regeneration (template redraft + regenerate-with-AI), so
  // this slot only supplies the very first draft. No second, competing "redraft" button.
  if (prompt) {
    return (
      <>
        {hasArtifact && (
          <p className="muted">
            You already have the {noun === "video" ? "visualizer" : "card art"};
            these prompts are here if you want to make another.
          </p>
        )}
        <PromptBlock
          curatorId={curatorId}
          type={type}
          prompt={prompt}
          run={run}
          canGenerate={canGenerate}
          refresh={refresh}
        />
      </>
    );
  }

  return (
    <div className="prompt-slot prompt-slot--empty">
      <p className="muted">
        {hasArtifact
          ? `No ${noun} prompts drafted — you already have the artifact, so nothing has been spent on them.`
          : `No ${noun} prompts yet. Drafting is on request, so adding an album never spends API calls on prompts you might not read.`}
      </p>
      <AsyncButton
        className={`btn ${hasArtifact ? "btn--ghost btn--sm" : "btn--primary"} btn--spend`}
        onClick={() => run(() => api.draftPrompt(curatorId, type))}
        pendingLabel="Drafting…"
        title={`Ask Gemini for five ${noun} prompts grounded in this album. Costs API calls; falls back to templates without a key.`}
      >
        Draft {noun} prompts
      </AsyncButton>
    </div>
  );
}

/**
 * Splice the generated clips into one loop in-app (issue #29): reorder (↑/↓), deselect (✕, re-add
 * from "Excluded"), then "Splice … into loop" concatenates the chosen clips and attaches the result
 * as the visualizer. Downloading a clip to edit externally + manual upload remain available.
 */
function SpliceControls({
  curatorId,
  clips,
  run,
}: {
  curatorId: string;
  clips: VideoClip[];
  run: Run;
}) {
  const allIndices = clips.map((c) => c.index);
  const [order, setOrder] = useState<number[]>(allIndices);
  // Opt-in seam crossfade (issue #56): plain concat is the default; 0.5s blends the hard cuts.
  const [crossfade, setCrossfade] = useState(false);
  const CROSSFADE_SEC = 0.5;
  // Reset the selection when the clip set changes (e.g. clips regenerated).
  const clipKey = allIndices.join(",");
  useEffect(() => {
    setOrder(clipKey === "" ? [] : clipKey.split(",").map(Number));
  }, [clipKey]);

  const label = new Map(
    clips.map((c) => [c.index, c.nudge || `Clip ${c.index + 1}`]),
  );
  const move = (pos: number, delta: number) =>
    setOrder((cur) => {
      const j = pos + delta;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[pos], next[j]] = [next[j]!, next[pos]!];
      return next;
    });
  const remove = (idx: number) =>
    setOrder((cur) => cur.filter((x) => x !== idx));
  const add = (idx: number) => setOrder((cur) => [...cur, idx]);
  const excluded = allIndices.filter((i) => !order.includes(i));

  return (
    <div className="splice">
      <div className="splice__list">
        {order.map((idx, pos) => (
          <div key={idx} className="splice__item">
            <span className="splice__pos">{pos + 1}</span>
            <span className="splice__label">{label.get(idx)}</span>
            <button
              className="btn btn--sm"
              disabled={pos === 0}
              onClick={() => move(pos, -1)}
              aria-label={`Move ${label.get(idx)} earlier`}
            >
              ↑
            </button>
            <button
              className="btn btn--sm"
              disabled={pos === order.length - 1}
              onClick={() => move(pos, 1)}
              aria-label={`Move ${label.get(idx)} later`}
            >
              ↓
            </button>
            <button
              className="btn btn--sm"
              onClick={() => remove(idx)}
              aria-label={`Remove ${label.get(idx)}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {excluded.length > 0 && (
        <div className="splice__excluded">
          <span className="muted">Excluded:</span>
          {excluded.map((idx) => (
            <button key={idx} className="btn btn--sm" onClick={() => add(idx)}>
              + {label.get(idx)}
            </button>
          ))}
        </div>
      )}
      <label className="splice__opt">
        <input
          type="checkbox"
          checked={crossfade}
          onChange={(e) => setCrossfade(e.target.checked)}
        />
        Crossfade the seams ({CROSSFADE_SEC}s) — smoother, but trims a little
        from each clip
      </label>
      <AsyncButton
        className="btn btn--primary btn--sm"
        disabled={order.length === 0}
        onClick={() =>
          run(() =>
            api.spliceVisualizer(
              curatorId,
              order,
              crossfade ? CROSSFADE_SEC : undefined,
            ),
          )
        }
        pendingLabel="Splicing…"
        title="Concatenate the selected clips (in this order) into one looping MP4 and attach it"
      >
        Splice {order.length} clip{order.length === 1 ? "" : "s"} into loop
      </AsyncButton>
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
            aria-busy={generating || undefined}
            title="Generate short clips from the album cover with Gemini, one per prompt variant"
          >
            {generating && <Spinner />}{" "}
            {generateLabel(
              gen,
              "Generate clips with AI",
              "Regenerate clips with AI",
              clips.length > 0,
            )}
          </button>
          {generating && (
            <button
              className="btn btn--sm btn--danger"
              onClick={gen.cancel}
              title="Stop the in-flight generation"
            >
              Cancel
            </button>
          )}
          {clips.length > 0 && !generating && (
            <span className="muted">
              Splice them into one loop below, or download a clip to edit
              externally.
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

      {clips.length > 0 && (
        <SpliceControls curatorId={curatorId} clips={clips} run={run} />
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
            <AsyncButton
              className="btn btn--sm btn--danger"
              onClick={() => run(() => api.detachVideo(curatorId, true))}
              pendingLabel="Detaching…"
            >
              Detach
            </AsyncButton>
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
  // Choosing a candidate is a quick server call; disable the gallery while it lands so a second
  // click can't race it (issue #62).
  const [selecting, wrapSelect] = usePending();

  return (
    <div className="cardart">
      {canGenerate && (
        <div className="row-actions">
          <button
            className="btn btn--sm"
            onClick={gen.start}
            disabled={generating}
            aria-busy={generating || undefined}
            title="Generate a set of card-art options with Gemini, one per prompt variant"
          >
            {generating && <Spinner />}{" "}
            {generateLabel(
              gen,
              "Generate options with AI",
              "Regenerate options with AI",
              candidates.length > 0,
            )}
          </button>
          {generating && (
            <button
              className="btn btn--sm btn--danger"
              onClick={gen.cancel}
              title="Stop the in-flight generation"
            >
              Cancel
            </button>
          )}
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
              disabled={selecting}
              aria-busy={selecting || undefined}
              onClick={() =>
                wrapSelect(() =>
                  run(() => api.selectCardArt(curatorId, c.index)),
                )
              }
            >
              <img
                src={cardArtCandidateUrl(curatorId, c.index)}
                alt={c.nudge || `option ${c.index + 1}`}
              />
              <span>
                {c.nudge || `Option ${c.index + 1}`}
                {/* A cover-anchored option that generated only without the cover no longer
                    re-renders the sleeve — say so rather than leave it to be inferred from the
                    picture looking off (ADR 0032). */}
                {c.coverReferenceDropped && (
                  <em
                    className="muted"
                    title="Gemini refused this prompt with the album cover attached; it generated without the cover reference, so it won't closely match the sleeve."
                  >
                    {" "}
                    · without cover reference
                  </em>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* A refused variant used to be an unexplained gap in the gallery (issue #152). */}
      {(asset.cardArtRefusals ?? []).length > 0 && (
        <div className="banner banner--warn">
          <strong>Gemini declined some options.</strong>
          <ul>
            {(asset.cardArtRefusals ?? []).map((r) => (
              <li key={r.index}>
                {r.nudge || `Option ${r.index + 1}`} — {r.reason}
                {r.retriedWithoutCover &&
                  " (also refused without the cover reference)"}
              </li>
            ))}
          </ul>
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
            <AsyncButton
              className="btn btn--sm btn--danger"
              onClick={() => run(() => api.detachCardArt(curatorId, true))}
              pendingLabel="Detaching…"
            >
              Detach
            </AsyncButton>
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
        <AsyncButton
          className="btn btn--primary"
          onClick={() => run(() => api.approvePreview(curatorId))}
          pendingLabel="Saving…"
        >
          Looks good →
        </AsyncButton>
        <AsyncButton
          className="btn"
          onClick={() =>
            run(() => api.rejectPreview(curatorId, "awaiting_video"))
          }
          pendingLabel="Saving…"
        >
          Something's off — back to video
        </AsyncButton>
        <AsyncButton
          className="btn btn--ghost"
          onClick={() =>
            run(() => api.rejectPreview(curatorId, "awaiting_review"))
          }
          pendingLabel="Saving…"
        >
          Back to palette
        </AsyncButton>
      </div>
    </div>
  );
}

/**
 * The last human step (step 11, curator-spec §7): mark each physical sticker written, then mark the
 * album physically verified. Writing the sleeve (scanned on the stand) advances the album to
 * awaiting_verify; the card is independent bookkeeping. Verifying finishes onboarding.
 */

/**
 * The exact string to burn into a sticker, and a QR of it (issue #102). Fetched rather than composed
 * here: this string ends up physically on a tag, so it has one source of truth — and retyping an
 * 8-character base32 id is the one step a human can get wrong, silently (the tag writes fine and
 * simply never resolves at scan time).
 */
function TagPayload({
  curatorId,
  object,
}: {
  curatorId: string;
  object: "sleeve" | "card";
}) {
  const [data, setData] = useState<{
    payload: string;
    qrDataUrl: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .tagPayload(curatorId, object)
      .then((d) => live && setData(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [curatorId, object]);

  // Degrade to the derivable URI rather than showing nothing: the Flipper .nfc download beside this
  // still works, so a failed QR fetch must not block the whole tag-write flow.
  const fallback =
    object === "card"
      ? `curator:card:${curatorId}`
      : `curator:album:${curatorId}`;

  return (
    <div className="tagwrite__payload-block">
      {data ? (
        <img
          className="tagwrite__qr"
          src={data.qrDataUrl}
          alt={`QR code for ${data.payload}`}
          title="Scan with your phone to write this tag in NFC Tools"
        />
      ) : (
        <div className="tagwrite__qr tagwrite__qr--empty" aria-hidden="true" />
      )}
      <code className="tagwrite__uri">{data?.payload ?? fallback}</code>
      {failed && <em className="tagwrite__qr-error">QR unavailable</em>}
    </div>
  );
}

export function TagWriteSection({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
}) {
  const state = asset.roadie.state;
  const tag = asset.tag;
  const verified = state === "verified";
  const canVerify = state === "awaiting_verify";

  // Sleeve and card carry different URIs since ADR 0034: a sleeve is curator:album (you play the
  // vinyl), a card is curator:card (Amp streams it over Sonos). Each row shows its URI and a Flipper
  // .nfc download for that object.
  const writeRow = (object: "sleeve" | "card", label: string) => {
    const written = tag?.[object]?.written ?? false;
    const nfcHref = `/api/albums/${curatorId}/tag.nfc${object === "card" ? "?object=card" : ""}`;
    return (
      <div className="tagwrite__obj">
        <TagPayload curatorId={curatorId} object={object} />
        <a className="btn btn--sm" href={nfcHref} download>
          Download {label} .nfc
        </a>
        {written ? (
          <span className="tagwrite__done">✓ {label} written</span>
        ) : (
          <button
            className="btn btn--sm"
            onClick={() => run(() => api.markTagWritten(curatorId, object))}
          >
            Mark {label} written
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="tagwrite">
      <div className="tagwrite__payload muted">
        Write each URI to its sticker (NFC Tools), or download the Flipper .nfc.
        The <strong>card</strong> plays over Sonos; the <strong>sleeve</strong>{" "}
        is for the vinyl.{" "}
        {/* Never written a tag before? The how-to lives in-app (issue #103), reachable from the
            moment the question actually arises rather than buried in a repo doc. */}
        <Link to="/help/tags" className="tagwrite__help">
          How do I write these?
        </Link>
      </div>
      <div className="tagwrite__objects">
        {writeRow("sleeve", "sleeve tag")}
        {writeRow("card", "card tag")}
      </div>
      {verified ? (
        <div className="banner banner--ok">
          Verified ✓ — this album is fully onboarded.
        </div>
      ) : (
        <button
          className="btn btn--primary"
          disabled={!canVerify}
          onClick={() => run(() => api.verifyAlbum(curatorId))}
          title={
            canVerify
              ? "Record the physical scan check and finish onboarding"
              : "Write the sleeve tag first"
          }
        >
          Mark physically verified
        </button>
      )}
    </div>
  );
}
