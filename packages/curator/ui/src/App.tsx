import { useEffect } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { usePoll } from "./hooks";
import { recordActivity } from "./roadieLog";
import { Collection } from "./pages/Collection";
import { AlbumDetail } from "./pages/AlbumDetail";
import { AddAlbum } from "./pages/AddAlbum";
import { DemoRoom } from "./pages/DemoRoom";
import { Settings } from "./pages/Settings";
import { SystemStatus } from "./pages/SystemStatus";
import { TagHelp } from "./pages/TagHelp";
import { Masthead } from "./components/Masthead";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConfirmProvider } from "./components/Confirm";
import { BatchProgress } from "./components/BatchProgress";
import { attachRunningBatch } from "./batchJob";
import { attachRunningDiscogsSync } from "./discogsSyncJob";
import { DiscogsSyncProgress } from "./components/DiscogsSyncProgress";

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
  }, []);

  // Fold Roadie's activity into the session log. It needs the album list to turn a curatorId into a
  // title, which is the whole reason the log can't be built from the status response alone.
  useEffect(() => {
    if (!status || !albums) return;
    const byId = new Map(albums.map((a) => [a.curatorId, a.title]));
    recordActivity(status.activity, (id) => byId.get(id) || null);
  }, [status, albums]);

  const roadieWorking = Boolean(
    status && !status.paused && (status.current || status.queueDepth > 0),
  );

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
                  <Collection albums={albums} error={albumsPoll.error} />
                }
              />
              <Route path="/add" element={<AddAlbum />} />
              {/* Discogs becomes its own screen (a synced collection, not an album picker). Until
                  that lands the nav item opens the Add screen's Discogs tab, which is where that
                  browser lives today — a real destination rather than a dead nav item. */}
              <Route
                path="/discogs"
                element={<AddAlbum initialTab="discogs" />}
              />
              <Route path="/albums/:curatorId" element={<AlbumDetail />} />
              <Route
                path="/albums/:curatorId/:section"
                element={<AlbumDetail />}
              />
              <Route path="/demo/:curatorId" element={<DemoRoom />} />
              <Route path="/system" element={<SystemStatus />} />
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
        <div className="job-stack">
          <BatchProgress />
          <DiscogsSyncProgress />
        </div>
      </div>
    </ConfirmProvider>
  );
}
