import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type AlbumAsset } from "../api";
import { STATE_LABEL, STEPPER, stepperIndex, isProcessing } from "../format";
import { usePoll } from "../hooks";
import { Cover, StateBadge, Spinner } from "../components/common";
import { PaletteEditor } from "../components/PaletteEditor";
import {
  PromptBlock,
  VideoSection,
  CardArtSection,
  PreviewSection,
  TagWriteSection,
  type Run,
} from "../components/workflow";

/** True when the palette was (re)generated or hand-edited after a prompt was drafted, so the prompt's
 * embedded hex colors are stale. Both timestamps are ISO-8601 UTC, so a string compare is chronological. */
const promptIsStale = (
  paletteGeneratedAt: string | undefined,
  promptGeneratedAt: string | undefined,
): boolean =>
  paletteGeneratedAt != null &&
  promptGeneratedAt != null &&
  promptGeneratedAt < paletteGeneratedAt;

/** Horizontal stepper of the human-driven milestones, current step highlighted (spec §10). */
function Stepper({ asset }: { asset: AlbumAsset }) {
  const idx = stepperIndex(asset.roadie.state);
  return (
    <ol className="stepper">
      {STEPPER.map((s, i) => {
        const cls = i < idx ? "done" : i === idx ? "current" : "pending";
        return (
          <li key={s} className={`stepper__step stepper__step--${cls}`}>
            {STATE_LABEL[s]}
          </li>
        );
      })}
    </ol>
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
  // Whether API artifact generation is enabled (opt-in; default off — see Settings). Polled slowly.
  const { data: gemini } = usePoll(api.geminiSettings, 30000);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Shared action runner: clear any error, await the action, re-poll, and surface failures.
  const run = useCallback<Run>(
    async (fn) => {
      setBusy(true);
      setActionError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

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
  const processing = isProcessing(roadie.state);
  // Once Roadie has drafted prompts (awaiting_review onward), the workflow sections are relevant.
  const inWorkflow = !processing && palette != null;
  // Editing the palette bumps its generatedAt past the prompts' — flag the drift so the user redrafts.
  const promptsStale =
    palette != null &&
    (promptIsStale(palette.generatedAt, promptDrafts?.video?.generatedAt) ||
      promptIsStale(palette.generatedAt, promptDrafts?.cardArt?.generatedAt));

  const del = async () => {
    if (!confirm(`Delete "${m.name || curatorId}"? The asset file is removed.`))
      return;
    setActionError(null);
    try {
      await api.deleteAlbum(curatorId);
      navigate("/");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page detail">
      <aside className="detail__left">
        <button className="btn btn--ghost" onClick={() => navigate("/")}>
          ← Queue
        </button>
        <Cover
          curatorId={curatorId}
          title={m.name || curatorId}
          version={asset.artwork?.contentHash}
        />
        <h1>{m.name || <em>fetching…</em>}</h1>
        <div className="detail__artist">{m.artist}</div>
        <div className="detail__meta">
          {m.year && <span>{m.year}</span>}
          <span className="tag">{m.source}</span>
          {/* For a Discogs album the cover may be resolved from Spotify (issue #58) — show which. */}
          {m.source === "discogs" && asset.artwork?.source && (
            <span className="tag" title="Cover art source">
              cover: {asset.artwork.source}
            </span>
          )}
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
              onClick={() => run(() => api.retry(curatorId))}
              disabled={busy}
            >
              {busy ? "Working…" : "Retry"}
            </button>
          )}
          {palette && (
            <button
              className="btn"
              onClick={() => navigate(`/demo/${curatorId}`)}
              title="Preview the runtime experience: video + your real Hue lights"
            >
              ▶ Demo Room
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
                {palette.reason ? ` (${palette.reason})` : ""}. Hand-craft it
                below, or re-extract from a different cover.
              </div>
            )}
            {promptsStale && (
              <div className="banner banner--warn">
                You changed the palette after the prompts were drafted — the
                video and card-art prompts below still reference the old colors.
                Redraft them to match.
              </div>
            )}
            <PaletteEditor
              curatorId={curatorId}
              asset={asset}
              run={run}
              busy={busy}
            />
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

        {roadie.state === "awaiting_preview" && (
          <Section title="Preview">
            <PreviewSection curatorId={curatorId} asset={asset} run={run} />
          </Section>
        )}

        {inWorkflow && promptDrafts?.video && (
          <Section title="Video prompt">
            <PromptBlock
              curatorId={curatorId}
              type="video"
              prompt={promptDrafts.video}
              run={run}
              canGenerate={
                (gemini?.generateVideo ?? false) && asset.artwork != null
              }
              refresh={refresh}
            />
          </Section>
        )}

        {inWorkflow && (
          <Section title="Video">
            <VideoSection
              curatorId={curatorId}
              asset={asset}
              run={run}
              refresh={refresh}
              canGenerate={gemini?.generateVideo ?? false}
            />
          </Section>
        )}

        {inWorkflow && promptDrafts?.cardArt && (
          <Section title="Card art prompt">
            <PromptBlock
              curatorId={curatorId}
              type="cardArt"
              prompt={promptDrafts.cardArt}
              run={run}
              canGenerate={gemini?.generateCardArt ?? false}
            />
          </Section>
        )}

        {inWorkflow && (
          <Section title="Card art">
            <CardArtSection
              curatorId={curatorId}
              asset={asset}
              run={run}
              refresh={refresh}
              canGenerate={gemini?.generateCardArt ?? false}
            />
          </Section>
        )}

        {(roadie.state === "awaiting_tag_write" ||
          roadie.state === "awaiting_verify" ||
          roadie.state === "verified") && (
          <Section title="Tag & verify">
            <TagWriteSection curatorId={curatorId} asset={asset} run={run} />
          </Section>
        )}
      </main>
    </div>
  );
}
