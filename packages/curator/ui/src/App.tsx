import { useEffect } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { usePoll } from "./hooks";
import { recordActivity, roadieStanding } from "./roadieLog";
import { Collection } from "./pages/Collection";
import { Record } from "./pages/Record";
import { AddRecord } from "./pages/AddRecord";
import { Discogs } from "./pages/Discogs";
import { Room } from "./pages/Room";
import { Settings } from "./pages/Settings";
import { System } from "./pages/System";
import { TagHelp } from "./pages/TagHelp";
import { Masthead } from "./components/Masthead";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConfirmProvider } from "./components/Confirm";
import { BatchProgress } from "./components/BatchProgress";
import { attachRunningBatch } from "./batchJob";
import { attachRunningDiscogsSync } from "./discogsSyncJob";
import { attachRunningSpotifyBackfill } from "./spotifyBackfillJob";
import { DiscogsSyncProgress } from "./components/DiscogsSyncProgress";
import { SpotifyBackfillProgress } from "./components/SpotifyBackfillProgress";
import { ReadyToast } from "./components/ReadyToast";

/**
 * The shell (ADR 0052): a masthead, a screen, and the two background-sweep panels.
 *
 * What used to be here and is deliberately gone: the `⌘K` command palette and its header button, the
 * `n` and `⌘,` shortcuts, the "needs you" count, and the app-wide Roadie strip. The keyboard layer
 * was withdrawn in favour of clarity; the strip's job — saying what Roadie is doing — is split
 * between the masthead indicator and the collection's own log, neither of which names a state or an
 * id.
 *
 * Both polls live here rather than in the screens because two consumers need each: the masthead and
 * the collection both read the album list, and the Roadie indicator and the session log both read
 * the status. Polling once and passing down is two requests per interval, not four.
 */
export function App() {
  const albumsPoll = usePoll(api.albums, 3000);
  const statusPoll = usePoll(api.status, 2000);
  const albums = albumsPoll.data?.albums ?? null;
  const status = statusPoll.data;

  // Reattach to a sweep that was already running (issue #104) — a reload during one must not leave
  // it running invisibly.
  useEffect(() => {
    void attachRunningBatch();
    void attachRunningDiscogsSync();
    void attachRunningSpotifyBackfill();
  }, []);

  // Fold Roadie's activity into the session log. It needs the album list to turn a curatorId into a
  // title, which is the whole reason the log can't be built from the status response alone.
  useEffect(() => {
    if (!status || !albums) return;
    const byId = new Map(albums.map((a) => [a.curatorId, a.title]));
    recordActivity(status.activity, (id) => byId.get(id) || null);
  }, [status, albums]);

  // One definition of "Roadie is working", shared with the log strip that reports it in words —
  // the masthead dot and the strip disagreeing about whether Roadie is busy is exactly the kind of
  // drift that made a finished Roadie look wedged in the first place (ADR 0057).
  const roadieWorking = roadieStanding(status ?? null).busy;

  // Per-route boundary keyed on the path: a page that throws mid-render is contained to the body
  // (the masthead survives), and navigating elsewhere clears the error (issue #63).
  const { pathname } = useLocation();
  return (
    <ConfirmProvider>
      <div className="app">
        <Masthead albums={albums} roadieWorking={roadieWorking} />
        <div className="app__body">
          <ErrorBoundary variant="route" resetKey={pathname}>
            <Routes>
              <Route
                path="/"
                element={
                  <Collection
                    albums={albums}
                    error={albumsPoll.error}
                    status={status ?? null}
                  />
                }
              />
              <Route path="/add" element={<AddRecord />} />
              <Route path="/discogs" element={<Discogs albums={albums} />} />
              {/* No segment → Lights. The record always opens on the same tab (ADR 0052), so a
                  click from the collection is predictable rather than state-dependent. */}
              <Route
                path="/albums/:curatorId"
                element={<Record albums={albums} />}
              />
              <Route
                path="/albums/:curatorId/:section"
                element={<Record albums={albums} />}
              />
              <Route
                path="/room/:curatorId"
                element={<Room albums={albums} />}
              />
              {/* The old address, kept working: it is in the Demo Room's own history and in any
                  link written before the overhaul. Same screen, one name. */}
              <Route
                path="/demo/:curatorId"
                element={<Room albums={albums} />}
              />
              <Route path="/system" element={<System />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/help/tags" element={<TagHelp />} />
              <Route
                path="*"
                element={
                  <div className="pp-page">
                    <h1 className="pp-title">Nothing here</h1>
                    <p className="pp-prose">
                      That address doesn&apos;t go anywhere.{" "}
                      <Link to="/">Back to the collection</Link>.
                    </p>
                  </div>
                }
              />
            </Routes>
          </ErrorBoundary>
        </div>
        {/* Both sweeps can run at once; the stack keeps them from sharing one corner. */}
        <ReadyToast albums={albums} />
        <div className="job-stack">
          <BatchProgress />
          <DiscogsSyncProgress />
          <SpotifyBackfillProgress />
        </div>
      </div>
    </ConfirmProvider>
  );
}
