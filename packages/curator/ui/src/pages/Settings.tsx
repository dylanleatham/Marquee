import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { usePoll } from "../hooks";

/**
 * App settings. Today: Spotify credentials — needed for search + add-by-URL, and the only thing the
 * packaged desktop app can't pick up from a repo `.env`. Creds are stored in the data folder and
 * take effect on the next launch (the Spotify client + Roadie are built once at boot).
 */
export function Settings() {
  const navigate = useNavigate();
  const { data: status, refresh } = usePoll(api.spotifySettings, 15000);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { data: gemini, refresh: refreshGemini } = usePoll(
    api.geminiSettings,
    15000,
  );
  const [apiKey, setApiKey] = useState("");
  const [geminiBusy, setGeminiBusy] = useState(false);
  const [geminiError, setGeminiError] = useState<string | null>(null);
  const [geminiSaved, setGeminiSaved] = useState(false);

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.saveSpotifySettings(clientId.trim(), clientSecret.trim());
      setSaved(true);
      setClientSecret(""); // don't keep the secret in the field after saving
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveGemini = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setGeminiBusy(true);
    setGeminiError(null);
    setGeminiSaved(false);
    try {
      await api.saveGeminiSettings(apiKey.trim());
      setGeminiSaved(true);
      setApiKey(""); // don't keep the key in the field after saving
      await refreshGemini();
    } catch (err) {
      setGeminiError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setGeminiBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <button className="btn btn--ghost" onClick={() => navigate("/")}>
          ← Queue
        </button>
        <h1>Settings</h1>
      </div>

      <section className="detail-section">
        <h2>Spotify</h2>
        <p className="muted">
          Spotify search and add-by-URL need API credentials. Create an app in
          the{" "}
          <a
            href="https://developer.spotify.com/dashboard"
            target="_blank"
            rel="noreferrer"
          >
            Spotify Developer Dashboard
          </a>{" "}
          and paste its Client ID and Secret below. They're stored in your local
          data folder and never leave this machine. Manual album add works
          without them.
        </p>

        {status &&
          (status.configured ? (
            <div className="banner banner--ok">
              Connected
              {status.clientId
                ? ` — client ${status.clientId.slice(0, 8)}…`
                : ""}
              .
            </div>
          ) : (
            <div className="banner banner--warn">
              Not configured — Spotify search and add-by-URL are disabled.
            </div>
          ))}

        <form className="form" onSubmit={save}>
          <label>
            Client ID
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            Client Secret
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            className="btn btn--primary"
            disabled={busy || !clientId.trim() || !clientSecret.trim()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </form>

        {error && <div className="banner banner--error">{error}</div>}
        {saved && (
          <div className="banner banner--warn">
            Saved. <b>Restart Marquee</b> to connect Spotify.
          </div>
        )}
      </section>

      <section className="detail-section">
        <h2>Gemini</h2>
        <p className="muted">
          A Gemini API key lets Roadie draft richer, album-specific prompts
          (grounded in real details of each record) and generate the card art
          and visualizer clips. Create a key in{" "}
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
          >
            Google AI Studio
          </a>{" "}
          and paste it below. It's stored in your local data folder and never
          leaves this machine. Without it, Roadie falls back to the built-in
          prompt templates.
        </p>

        {gemini &&
          (gemini.configured ? (
            <div className="banner banner--ok">Connected.</div>
          ) : (
            <div className="banner banner--warn">
              Not configured — Roadie uses the built-in prompt templates.
            </div>
          ))}

        <form className="form" onSubmit={saveGemini}>
          <label>
            API Key
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button
            className="btn btn--primary"
            disabled={geminiBusy || !apiKey.trim()}
          >
            {geminiBusy ? "Saving…" : "Save"}
          </button>
        </form>

        {geminiError && (
          <div className="banner banner--error">{geminiError}</div>
        )}
        {geminiSaved && (
          <div className="banner banner--warn">
            Saved. <b>Restart Marquee</b> to enable Gemini.
          </div>
        )}
      </section>
    </div>
  );
}
