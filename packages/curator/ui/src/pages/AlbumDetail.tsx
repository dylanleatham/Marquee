import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  api,
  type AlbumAsset,
  type DraftedPrompt,
  type PaletteColor,
} from "../api";
import { STATE_LABEL, STEPPER, stepperIndex, isProcessing } from "../format";
import { usePoll } from "../hooks";
import { Cover, StateBadge, Spinner } from "../components/common";

/** Horizontal stepper of the human-driven milestones, current step highlighted (spec §10). */
function Stepper({ asset }: { asset: AlbumAsset }) {
  const idx = stepperIndex(asset.roadie.state);
  const processing = isProcessing(asset.roadie.state);
  return (
    <ol className="stepper">
      {STEPPER.map((s, i) => {
        const cls =
          i < idx
            ? "done"
            : i === idx
              ? "current"
              : processing
                ? "pending"
                : "pending";
        return (
          <li key={s} className={`stepper__step stepper__step--${cls}`}>
            {STATE_LABEL[s]}
          </li>
        );
      })}
    </ol>
  );
}

function Swatches({ colors }: { colors: PaletteColor[] }) {
  return (
    <div className="swatches">
      {colors.map((c, i) => (
        <div key={i} className="swatch" title={`${c.hex} · ${c.role}`}>
          <span className="swatch__chip" style={{ background: c.hex }} />
          <span className="swatch__hex">{c.hex}</span>
          <span className="swatch__role">{c.role}</span>
        </div>
      ))}
    </div>
  );
}

/** A drafted prompt in a code block with a Copy button (the seam humans hand to their video tool). */
function PromptBlock({
  label,
  prompt,
}: {
  label: string;
  prompt: DraftedPrompt;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(prompt.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="prompt">
      <div className="prompt__head">
        <h3>{label}</h3>
        <span className="tag">{prompt.template}</span>
        <button className="btn btn--sm" onClick={copy}>
          {copied ? "Copied ✓" : "Copy prompt"}
        </button>
      </div>
      <pre className="prompt__text">{prompt.text}</pre>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="detail-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function AlbumDetail() {
  const { curatorId = "" } = useParams();
  const navigate = useNavigate();
  const {
    data: asset,
    error,
    refresh,
  } = usePoll<AlbumAsset>(() => api.album(curatorId), 3000);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error)
    return (
      <div className="page">
        <button className="btn btn--ghost" onClick={() => navigate("/")}>
          ← Queue
        </button>
        <div className="banner banner--error">Couldn't load album: {error}</div>
      </div>
    );
  if (!asset)
    return (
      <div className="page">
        <Spinner /> Loading…
      </div>
    );

  const { metadata: m, roadie, palette, pattern, promptDrafts } = asset;
  const canRetry =
    roadie.state === "errored" || roadie.state === "needs_manual";

  const asError = (err: unknown) =>
    setActionError(err instanceof Error ? err.message : String(err));

  const retry = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await api.retry(curatorId);
      refresh();
    } catch (err) {
      asError(err);
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!confirm(`Delete "${m.name || curatorId}"? The asset file is removed.`))
      return;
    setActionError(null);
    try {
      await api.deleteAlbum(curatorId);
      navigate("/");
    } catch (err) {
      asError(err);
    }
  };

  return (
    <div className="page detail">
      <aside className="detail__left">
        <button className="btn btn--ghost" onClick={() => navigate("/")}>
          ← Queue
        </button>
        <Cover curatorId={curatorId} title={m.name || curatorId} />
        <h1>{m.name || <em>fetching…</em>}</h1>
        <div className="detail__artist">{m.artist}</div>
        <div className="detail__meta">
          {m.year && <span>{m.year}</span>}
          <span className="tag">{m.source}</span>
          {m.genres?.length ? <span>{m.genres.join(", ")}</span> : null}
        </div>
        <div className="detail__state">
          <StateBadge state={roadie.state} />
        </div>
        {roadie.lastError && (
          <div className="banner banner--error">
            {roadie.lastError.reason ? (
              <b>{roadie.lastError.reason}: </b>
            ) : null}
            {roadie.lastError.message}
          </div>
        )}
        <div className="detail__actions">
          {canRetry && (
            <button
              className="btn btn--primary"
              onClick={retry}
              disabled={busy}
            >
              {busy ? "Retrying…" : "Retry"}
            </button>
          )}
          <button className="btn btn--danger" onClick={del}>
            Delete
          </button>
        </div>
        {actionError && (
          <div className="banner banner--error">{actionError}</div>
        )}
        <code className="detail__id">{curatorId}</code>
      </aside>

      <main className="detail__right">
        <Stepper asset={asset} />

        {palette ? (
          <Section title="Palette">
            {palette.insufficient && (
              <div className="banner banner--warn">
                Palette looks monochrome
                {palette.reason ? ` (${palette.reason})` : ""}. You may want to
                hand-craft it. {/* editing lands in a later step */}
              </div>
            )}
            <Swatches colors={palette.colors} />
          </Section>
        ) : (
          <Section title="Palette">
            <p className="muted">
              Not generated yet — {STATE_LABEL[roadie.state]}.
            </p>
          </Section>
        )}

        {pattern && (
          <Section title="Pattern">
            <div className="kv">
              <span className="tag">{pattern.type}</span>
              <code>{JSON.stringify(pattern.params)}</code>
            </div>
          </Section>
        )}

        {promptDrafts?.video && (
          <Section title="Video prompt">
            <PromptBlock
              label="For your video tool"
              prompt={promptDrafts.video}
            />
          </Section>
        )}
        {promptDrafts?.cardArt && (
          <Section title="Card art prompt">
            <PromptBlock
              label="For your card-art tool"
              prompt={promptDrafts.cardArt}
            />
          </Section>
        )}

        <Section title="Coming in later steps">
          <p className="muted">
            Palette editing, video upload &amp; preview, tag writing, and
            physical verification arrive in subsequent build steps.
          </p>
        </Section>
      </main>
    </div>
  );
}
