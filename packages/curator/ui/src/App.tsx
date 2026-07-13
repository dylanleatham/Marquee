import { useEffect } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { usePoll } from "./hooks";
import { QueueView } from "./pages/QueueView";
import { AlbumDetail } from "./pages/AlbumDetail";
import { AddAlbum } from "./pages/AddAlbum";
import { RoadieStrip } from "./components/RoadieStrip";

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
  return (
    <div className="app">
      <header className="app__header">
        <Link to="/" className="app__brand">
          Curator
        </Link>
        <span className="app__tagline">Marquee collection</span>
      </header>
      <div className="app__body">
        <Routes>
          <Route path="/" element={<QueueView />} />
          <Route path="/add" element={<AddAlbum />} />
          <Route path="/albums/:curatorId" element={<AlbumDetail />} />
          <Route
            path="*"
            element={
              <div className="page">
                Not found. <Link to="/">Queue</Link>
              </div>
            }
          />
        </Routes>
      </div>
      <RoadieStrip />
    </div>
  );
}
