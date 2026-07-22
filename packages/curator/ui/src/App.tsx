import { useEffect } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { usePoll } from "./hooks";
import { QueueView } from "./pages/QueueView";
import { AlbumDetail } from "./pages/AlbumDetail";
import { AddAlbum } from "./pages/AddAlbum";
import { DemoRoom } from "./pages/DemoRoom";
import { Settings } from "./pages/Settings";
import { RoadieStrip } from "./components/RoadieStrip";
import { ErrorBoundary } from "./components/ErrorBoundary";

/** Keep the browser-tab title showing the "needs you right now" count — answers "sit down now?". */
function useTabBadge() {
  const { data } = usePoll(api.queueCounts, 5000);
  useEffect(() => {
    const n = data?.needsYou ?? 0;
    document.title = n > 0 ? `(${n}) Curator` : "Curator";
  }, [data]);
}

export function App() {
  useTabBadge();
  // Per-route boundary keyed on the path: a page that throws mid-render is contained to the body
  // (header + RoadieStrip survive), and navigating to another route clears the error (issue #63).
  const { pathname } = useLocation();
  return (
    <div className="app">
      <header className="app__header">
        <Link to="/" className="app__brand">
          Curator
        </Link>
        <span className="app__tagline">Marquee collection</span>
        <Link to="/settings" className="app__nav">
          Settings
        </Link>
      </header>
      <div className="app__body">
        <ErrorBoundary variant="route" resetKey={pathname}>
          <Routes>
            <Route path="/" element={<QueueView />} />
            <Route path="/add" element={<AddAlbum />} />
            <Route path="/albums/:curatorId" element={<AlbumDetail />} />
            <Route path="/demo/:curatorId" element={<DemoRoom />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="*"
              element={
                <div className="page">
                  Not found. <Link to="/">Queue</Link>
                </div>
              }
            />
          </Routes>
        </ErrorBoundary>
      </div>
      <RoadieStrip />
    </div>
  );
}
