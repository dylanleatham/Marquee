import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api, type AlbumAsset } from "../api";
import { STATE_LABEL, isProcessing, promptIsStale } from "../format";
import {
  WORKSTATIONS,
  READINESS_LABEL,
  readiness,
  workstationFromSegment,
} from "../rail";
import { usePoll } from "../hooks";
import { Cover, StateBadge, Spinner } from "../components/common";
import { PaletteEditor } from "../components/PaletteEditor";
import { ArtworkSection } from "../components/ArtworkSection";
import { useConfirm } from "../components/Confirm";
import { PreviewWorkstation } from "../components/PreviewWorkstation";
import {
  PromptSlot,
  VideoSection,
  CardArtSection,
  TagWriteSection,
  type Run,
} from "../components/workflow";

/**
 * The album detail is a **workbench, not a guided session** (ADR 0026). Artifacts arrive out of
 * order — a visualizer already rendered, card art already commissioned — so nothing here is gated by
 * `roadie.state`. Every workstation is always reachable; state only picks which one opens by default
 * and what each rail chip reports.
 */
export function AlbumDetail() {
  const { curatorId = "", section } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const {
    data: asset,
    error,
    refresh,
  } = usePoll<AlbumAsset>(() => api.album(curatorId), 3000);
  // Whether API artifact generation is enabled (opt-in; default off — see Settings). Polled slowly.
  const { data: gemini } = usePoll(api.geminiSettings, 30000);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Keyboard path (curator-ui-ux §9.1): 1–5 jump benches, Esc returns to the queue. Ten albums ×
  // mousing to every control is what turns a session into a chore. Everything here is also
  // reachable by mouse — the keyboard is an accelerator, never the only way.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        navigate("/");
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= WORKSTATIONS.length) {
        e.preventDefault();
        navigate(`/albums/${curatorId}/${WORKSTATIONS[n - 1]!.segment}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, curatorId]);

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
  const active = workstationFromSegment(section, roadie.state);
  // Editing the palette bumps its generatedAt past the prompts' — flag the drift so the user redrafts.
  const promptsStale =
    palette != null &&
    (promptIsStale(palette.generatedAt, promptDrafts?.video?.generatedAt) ||
      promptIsStale(palette.generatedAt, promptDrafts?.cardArt?.generatedAt));

  const del = async () => {
    const ok = await confirm({
      title: `Delete "${m.name || curatorId}"?`,
      body: "The asset file is removed. Media files stay on disk. This can't be undone.",
      confirmLabel: "Delete album",
      destructive: true,
    });
    if (!ok) return;
    setActionError(null);
    try {
      await api.deleteAlbum(curatorId);
      navigate("/");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const bench = WORKSTATIONS.find((w) => w.id === active)!;

  return (
    <div className="page page--wide detail">
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

        {/* The rail. Every station is always reachable — readiness reports, it never permits. */}
        <nav className="rail" aria-label="Workstations">
          {WORKSTATIONS.map((w) => {
            const r = readiness(w.id, asset);
            return (
              <Link
                key={w.id}
                to={`/albums/${curatorId}/${w.segment}`}
                className={`rail__item ${active === w.id ? "is-active" : ""}`}
                aria-current={active === w.id ? "page" : undefined}
              >
                <span className="rail__label">{w.label}</span>
                <span className={`rail__state rail__state--${r}`}>
                  <span aria-hidden="true" className="rail__dot" />
                  {READINESS_LABEL[r]}
                </span>
              </Link>
            );
          })}
        </nav>

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
        <header className="bench__head">
          <h2>{bench.label}</h2>
          <p className="muted">{bench.blurb}</p>
        </header>

        {active === "look" && (
          <>
            {palette?.insufficient && (
              <div className="banner banner--warn">
                Palette looks monochrome
                {palette.reason ? ` (${palette.reason})` : ""}. Hand-craft it
                below, or re-extract from a different cover.
              </div>
            )}
            {promptsStale && (
              <div className="banner banner--warn">
                You changed the palette after the prompts were drafted — the
                video and card-art prompts still reference the old colors.
                Redraft them to match.
              </div>
            )}
            {palette ? (
              <PaletteEditor curatorId={curatorId} asset={asset} run={run} />
            ) : (
              <p className="muted">
                Not generated yet — {STATE_LABEL[roadie.state]}.
                {isProcessing(roadie.state) &&
                  " The other workstations still accept anything you already have."}
              </p>
            )}
            {pattern && (
              <div className="kv">
                <span className="tag">{pattern.type}</span>
                <code>{JSON.stringify(pattern.params)}</code>
              </div>
            )}
            {/* The cover the palette is derived from — replacing a bad scan is a colour decision
                before it is a metadata one, so it lives here rather than in a settings screen. */}
            <h3 className="group-head">Artwork</h3>
            <ArtworkSection curatorId={curatorId} asset={asset} run={run} />
          </>
        )}

        {active === "video" && (
          <>
            <PromptSlot
              curatorId={curatorId}
              type="video"
              prompt={promptDrafts?.video}
              hasArtifact={Boolean(asset.visualizer)}
              run={run}
              canGenerate={
                (gemini?.generateVideo ?? false) && asset.artwork != null
              }
              refresh={refresh}
            />
            <VideoSection
              curatorId={curatorId}
              asset={asset}
              run={run}
              refresh={refresh}
              canGenerate={gemini?.generateVideo ?? false}
            />
          </>
        )}

        {active === "card" && (
          <>
            <PromptSlot
              curatorId={curatorId}
              type="cardArt"
              prompt={promptDrafts?.cardArt}
              hasArtifact={Boolean(asset.cardArt)}
              run={run}
              canGenerate={gemini?.generateCardArt ?? false}
            />
            <CardArtSection
              curatorId={curatorId}
              asset={asset}
              run={run}
              refresh={refresh}
              canGenerate={gemini?.generateCardArt ?? false}
            />
          </>
        )}

        {active === "preview" && (
          <PreviewWorkstation curatorId={curatorId} asset={asset} run={run} />
        )}

        {active === "ship" && (
          <TagWriteSection curatorId={curatorId} asset={asset} run={run} />
        )}
      </main>
    </div>
  );
}
