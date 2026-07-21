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

  // Spotify user login (Authorization Code + PKCE). Separate from the credential form above: creds
  // enable the app-token catalog reads; logging in adds a user session (personalized search now,
  // Connect playback later). Poll so the connected state updates after the browser handshake returns.
  const { data: auth, refresh: refreshAuth } = usePoll(
    api.spotifyAuthStatus,
    5000,
  );
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const connectSpotify = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const { authorizeUrl } = await api.spotifyLogin();
      // Opens the system browser in the desktop shell (setWindowOpenHandler), a new tab in dev.
      window.open(authorizeUrl, "_blank", "noopener");
    } catch (err) {
      setAuthError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const disconnectSpotify = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await api.spotifyDisconnect();
      await refreshAuth();
    } catch (err) {
      setAuthError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  // Discogs personal access token (ADR 0016). Same store + restart-to-apply story as Spotify.
  const { data: discogs, refresh: refreshDiscogs } = usePoll(
    api.discogsSettings,
    15000,
  );
  const [discogsToken, setDiscogsToken] = useState("");
  const [discogsUsername, setDiscogsUsername] = useState("");
  const [discogsBusy, setDiscogsBusy] = useState(false);
  const [discogsError, setDiscogsError] = useState<string | null>(null);
  const [discogsSaved, setDiscogsSaved] = useState(false);

  const saveDiscogs = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDiscogsBusy(true);
    setDiscogsError(null);
    setDiscogsSaved(false);
    try {
      await api.saveDiscogsSettings(
        discogsToken.trim(),
        discogsUsername.trim() || undefined,
      );
      setDiscogsSaved(true);
      setDiscogsToken(""); // don't keep the token in the field after saving
      await refreshDiscogs();
    } catch (err) {
      setDiscogsError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setDiscogsBusy(false);
    }
  };

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
      await api.saveGeminiSettings({ apiKey: apiKey.trim() });
      setGeminiSaved(true);
      setApiKey(""); // don't keep the key in the field after saving
      await refreshGemini();
    } catch (err) {
      setGeminiError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setGeminiBusy(false);
    }
  };

  // Toggling a generation flag persists immediately (no key re-entry needed).
  const toggleGeneration = async (patch: {
    generateCardArt?: boolean;
    generateVideo?: boolean;
  }) => {
    setGeminiError(null);
    setGeminiSaved(false);
    try {
      await api.saveGeminiSettings(patch);
      setGeminiSaved(true);
      await refreshGemini();
    } catch (err) {
      setGeminiError(err instanceof ApiError ? err.message : String(err));
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

        <h3 className="settings-subhead">Log in as a user</h3>
        <p className="muted">
          Optional: log in with your Spotify account to run search through your
          own session and unlock playback control (playing an album through your
          speakers, coming later). Without it, Curator uses app-only catalog
          access, which is enough for search and adding albums.
        </p>

        {auth?.connected ? (
          <div className="banner banner--ok">
            Logged in to Spotify.{" "}
            <button
              className="btn btn--ghost"
              onClick={disconnectSpotify}
              disabled={authBusy}
            >
              {authBusy ? "…" : "Disconnect"}
            </button>
          </div>
        ) : (
          <button
            className="btn btn--primary"
            onClick={connectSpotify}
            disabled={authBusy || !status?.configured}
            title={
              status?.configured
                ? undefined
                : "Add your Client ID and Secret first"
            }
          >
            {authBusy ? "Opening Spotify…" : "Connect Spotify"}
          </button>
        )}
        {authError && <div className="banner banner--error">{authError}</div>}
      </section>

      <section className="detail-section">
        <h2>Discogs</h2>
        <p className="muted">
          Browse your Discogs collection and send albums to Roadie. Create a
          personal access token in your{" "}
          <a
            href="https://www.discogs.com/settings/developers"
            target="_blank"
            rel="noreferrer"
          >
            Discogs developer settings
          </a>{" "}
          and paste it below. It's stored in your local data folder and never
          leaves this machine. The username is optional — it's read from your
          token when left blank.
        </p>

        {discogs &&
          (discogs.configured ? (
            <div className="banner banner--ok">
              Connected
              {discogs.username ? ` — ${discogs.username}` : ""}.
            </div>
          ) : (
            <div className="banner banner--warn">
              Not configured — Discogs collection browsing is disabled.
            </div>
          ))}

        <form className="form" onSubmit={saveDiscogs}>
          <label>
            Personal access token
            <input
              type="password"
              value={discogsToken}
              onChange={(e) => setDiscogsToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            Username (optional)
            <input
              value={discogsUsername}
              onChange={(e) => setDiscogsUsername(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button
            className="btn btn--primary"
            disabled={discogsBusy || !discogsToken.trim()}
          >
            {discogsBusy ? "Saving…" : "Save"}
          </button>
        </form>

        {discogsError && (
          <div className="banner banner--error">{discogsError}</div>
        )}
        {discogsSaved && (
          <div className="banner banner--warn">
            Saved. <b>Restart Marquee</b> to connect Discogs.
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

        <h3 className="settings-subhead">Artifact generation</h3>
        <p className="muted">
          Off by default: Curator just drafts the prompts for you to copy into
          your own tools. Turn these on to generate the artifacts through the
          API instead. <b>Card art</b> is cheap (~5 images per click);{" "}
          <b>video</b> uses metered Veo credits and can be expensive — leave it
          off and copy the prompt into Google Flow if you'd rather.
        </p>
        <label className="toggle">
          <input
            type="checkbox"
            checked={gemini?.generateCardArt ?? false}
            disabled={!gemini?.configured}
            onChange={(e) =>
              toggleGeneration({ generateCardArt: e.target.checked })
            }
          />
          Auto-generate card art (Nano Banana)
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={gemini?.generateVideo ?? false}
            disabled={!gemini?.configured}
            onChange={(e) =>
              toggleGeneration({ generateVideo: e.target.checked })
            }
          />
          Auto-generate visualizer clips (Veo — metered, can be pricey)
        </label>

        {geminiError && (
          <div className="banner banner--error">{geminiError}</div>
        )}
        {geminiSaved && (
          <div className="banner banner--warn">
            Saved. <b>Restart Marquee</b> to apply.
          </div>
        )}
      </section>
    </div>
  );
}
