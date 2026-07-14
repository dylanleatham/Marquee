// The interactive onboarding sections of the album detail (step 7): prompt (copy / regenerate /
// mark-copied), video (upload / player / detach), card art, and the preview checkpoint. Each action
// goes through the `run` helper the page provides, which handles errors + re-polls the album.
import { useEffect, useRef, useState } from "react";
import {
  api,
  videoUrl,
  thumbnailUrl,
  cardArtUrl,
  cardArtPrintUrl,
  VIDEO_TEMPLATES,
  CARD_ART_TEMPLATES,
  type AlbumAsset,
  type DraftedPrompt,
  type PromptType,
} from "../api";

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

/** A drafted prompt: copy, regenerate with a template, and (for video, at review) mark-copied. */
export function PromptBlock({
  curatorId,
  type,
  prompt,
  canMarkCopied,
  run,
}: {
  curatorId: string;
  type: PromptType;
  prompt: DraftedPrompt;
  canMarkCopied: boolean;
  run: Run;
}) {
  const [copied, setCopied] = useState(false);
  const templates = type === "video" ? VIDEO_TEMPLATES : CARD_ART_TEMPLATES;
  const copy = async () => {
    await navigator.clipboard.writeText(prompt.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="prompt">
      <div className="prompt__head">
        <select
          className="select"
          value={prompt.template}
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
        <button className="btn btn--sm" onClick={copy}>
          {copied ? "Copied ✓" : "Copy prompt"}
        </button>
        {canMarkCopied && (
          <button
            className="btn btn--primary btn--sm"
            onClick={() => run(() => api.markPromptCopied(curatorId, type))}
          >
            Mark copied →
          </button>
        )}
      </div>
      <pre className="prompt__text">{prompt.text}</pre>
    </div>
  );
}

/** Video: a drop zone until attached (only once past review), then an inline player + replace/detach. */
export function VideoSection({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const state = asset.roadie.state;
  const canUpload = state === "awaiting_video" || state === "awaiting_preview";
  const upload = (f: File) => {
    const form = new FormData();
    form.set("file", f);
    return run(() => api.uploadVideo(curatorId, form));
  };

  if (asset.visualizer) {
    return (
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
    );
  }

  return (
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
        : "Copy the video prompt above first, then attach your video here"}
    </label>
  );
}

/** Card art: independent of the state machine — attach any time, even after verified. */
export function CardArtSection({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = (f: File) => {
    const form = new FormData();
    form.set("file", f);
    return run(() => api.uploadCardArt(curatorId, form));
  };

  if (asset.cardArt) {
    return (
      <div>
        <img
          className="media-frame media-frame--art"
          src={cardArtUrl(curatorId)}
          alt="card art"
        />
        <div className="row-actions">
          <span className="muted">
            {asset.cardArt.originalFilename}
            {asset.cardArt.resolution ? ` · ${asset.cardArt.resolution}` : ""}
          </span>
          <a className="btn btn--sm" href={cardArtPrintUrl(curatorId)} download>
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
    );
  }

  return (
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
