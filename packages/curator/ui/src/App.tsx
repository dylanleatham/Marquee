import { useEffect } from "react";
import {
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { api } from "./api";
import { usePoll } from "./hooks";
import { QueueView } from "./pages/QueueView";
import { AlbumDetail } from "./pages/AlbumDetail";
import { AddAlbum } from "./pages/AddAlbum";
import { DemoRoom } from "./pages/DemoRoom";
import { Settings } from "./pages/Settings";
import { TagHelp } from "./pages/TagHelp";
import { RoadieStrip } from "./components/RoadieStrip";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConfirmProvider } from "./components/Confirm";

/**
 * The "needs you right now" count. This used to be written into `document.title` — an affordance
 * borrowed from the browser, where a tab shows it. Curator is a single-window Electron app with
 * `autoHideMenuBar`, so that put the number in the OS title bar, invisible while the window is
 * focused (curator-ui-ux §8). It belongs in the header, where you can actually read it.
 */
function NeedsYouCount() {
  const { data } = usePoll(api.queueCounts, 5000);
  const n = data?.needsYou ?? 0;
  if (!n) return null;
  return (
    <Link to="/" className="needs-you" title="Albums waiting on you right now">
      {n} <em>needs you</em>
    </Link>
  );
}

/**
 * Global keyboard shortcuts (curator-ui-ux §9.1). The success criterion is working through ten
 * albums in one session; ten albums × mousing to every control is what makes that a chore. Every
 * shortcut here is also reachable by mouse — the keyboard is an accelerator, never the only path.
 */
function useGlobalKeys() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never hijack a key the user is typing into a field.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === ",") {
        e.preventDefault();
        navigate("/settings");
      } else if (!mod && e.key === "n") {
        e.preventDefault();
        navigate("/add");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
}

export function App() {
  useGlobalKeys();
  // Per-route boundary keyed on the path: a page that throws mid-render is contained to the body
  // (header + RoadieStrip survive), and navigating to another route clears the error (issue #63).
  const { pathname } = useLocation();
  return (
    <ConfirmProvider>
      <div className="app">
        <header className="app__header">
          <Link to="/" className="app__brand">
            Curator
          </Link>
          <span className="app__tagline">Marquee collection</span>
          <NeedsYouCount />
          <Link to="/settings" className="app__nav">
            Settings
          </Link>
        </header>
        <div className="app__body">
          <ErrorBoundary variant="route" resetKey={pathname}>
            <Routes>
              <Route path="/" element={<QueueView />} />
              <Route path="/add" element={<AddAlbum />} />
              {/* The rail is routable (ADR 0026): back/forward work and a deep link opens the
                  workstation you meant. No segment → the state-derived default. */}
              <Route path="/albums/:curatorId" element={<AlbumDetail />} />
              <Route
                path="/albums/:curatorId/:section"
                element={<AlbumDetail />}
              />
              <Route path="/demo/:curatorId" element={<DemoRoom />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/help/tags" element={<TagHelp />} />
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
    </ConfirmProvider>
  );
}
