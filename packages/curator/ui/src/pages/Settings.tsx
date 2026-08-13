import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { AsyncButton } from "../components/common";
import { DefaultVisualizerPanel } from "../components/DefaultVisualizerPanel";
import { errorMessage } from "../errors";
import { SERVICE_GLOSS } from "../system";

/**
 * Settings (ADR 0052) — two columns: what the room is plugged into, and what Roadie may do on its own.
 *
 * The second column is the point of the rewrite. These were feature flags with technical names;
 * framing them as **permissions** is what makes "Metered and pricey" the natural thing to write next
 * to one, and turns a settings page into a place you can answer "what is this going to cost me?".
 */

/** Which room the lights are in. Conductor owns this value, so it needs an unreachable state. */
function WhichRoom() {
  const { data: status, refresh } = usePoll(api.demoStatus, 15000);
  const { data: rooms } = usePoll(api.demoRooms, 60000);
  const [problem, setProblem] = useState<string | null>(null);

  if (status && !status.reachable)
    return (
      <p className="setrow setrow--muted">
        <span className="pp-label">WHICH ROOM</span>
        <span>
          Conductor isn&apos;t answering, so the rooms can&apos;t be listed.
        </span>
      </p>
    );

  // Reachable but holding no rooms is its own state — a picker with one "not chosen yet" line in it
  // looks like a screen that hasn't loaded, when the real answer is that no bridge is paired.
  if (rooms && rooms.rooms.length === 0)
    return (
      <p className="setrow setrow--muted">
        <span className="pp-label">WHICH ROOM</span>
        <span>
          Conductor has no rooms yet — pair a Hue bridge and they turn up here.
        </span>
      </p>
    );

  return (
    <label className="setrow">
      <span className="pp-label">WHICH ROOM</span>
      <select
        className="setrow__select"
        value={status?.listeningRoomId ?? ""}
        onChange={(e) =>
          void api
            .demoSetRoom(e.target.value)
            .then(() => {
              setProblem(null);
              refresh();
            })
            .catch((err: unknown) => setProblem(errorMessage(err)))
        }
      >
        <option value="">not chosen yet</option>
        {(rooms?.rooms ?? []).map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      {problem && <span className="setrow__problem">{problem}</span>}
    </label>
  );
}

/**
 * One account: whether it is connected, and a way to change it.
 *
 * Secrets are write-only — the server never sends them back — so CHANGE can only ever mean "type it
 * again", never "here is what you have". Saying so beats an empty box that looks like data loss.
 */
function Account({
  name,
  connected,
  detail,
  children,
}: {
  name: string;
  connected: boolean;
  detail?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="account">
      <p className="account__head">
        <span
          className={`pp-dot${connected ? " pp-dot--positive" : ""}`}
          aria-hidden="true"
        />
        {/* State in words, never the dot alone. */}
        <span className="account__name">
          {name} — {connected ? (detail ?? "connected") : "not connected"}
        </span>
        <button
          type="button"
          className="account__change"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "CANCEL" : "CHANGE"}
        </button>
      </p>
      {open && <div className="account__form">{children}</div>}
    </div>
  );
}

/**
 * How often the Discogs sweep runs, in words.
 *
 * The interval itself is not editable here — it is a number of minutes, which is a worse question to
 * put on a permissions column than "may Roadie do this at all", and the answer is almost always the
 * default. It is still a real setting on `PUT /api/settings/discogs`, so this reads the value rather
 * than asserting one.
 */
export function syncCadence(minutes: number | undefined): string {
  if (!minutes || minutes >= 1440) return "Checks once a day";
  if (minutes >= 60) {
    const h = Math.round(minutes / 60);
    return h === 1 ? "Checks every hour" : `Checks every ${h} hours`;
  }
  return `Checks every ${minutes} minutes`;
}

/**
 * A permission Roadie either has or doesn't. A 15px ink square — no switch chrome.
 *
 * `pinned` is the case where the answer is fixed above `settings.json` — `config.toml` or the
 * environment — so a click here cannot take effect. It renders as a statement rather than a
 * checkbox, the same call as the read-only service URLs: a control the system will refuse is worse
 * than no control ([#240](https://github.com/dylanleatham/Marquee/issues/240)).
 */
function Permission({
  label,
  note,
  on,
  onChange,
  busy,
  pinned,
}: {
  label: string;
  note: string;
  on: boolean;
  onChange: (next: boolean) => void;
  busy?: boolean;
  pinned?: boolean;
}) {
  if (pinned)
    return (
      <p className="perm perm--pinned">
        <span className="perm__box perm__box--pinned" aria-hidden="true">
          {on ? "✓" : "—"}
        </span>
        <span>
          <span className="perm__label">
            {label} — {on ? "on" : "off"}
          </span>
          <span className="perm__note">
            {note} Set in <code>config.toml</code> or the environment, which win
            over this screen; change it there and restart.
          </span>
        </span>
      </p>
    );

  return (
    <label className="perm">
      <input
        type="checkbox"
        className="perm__box"
        checked={on}
        disabled={busy}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="perm__label">{label}</span>
        <span className="perm__note">{note}</span>
      </span>
    </label>
  );
}

export function Settings() {
  const { data: services } = usePoll(api.serviceHealth, 30000);
  const { data: spotify, refresh: refreshSpotify } = usePoll(
    api.spotifySettings,
    30000,
  );
  const { data: spotifyAuth, refresh: refreshSpotifyAuth } = usePoll(
    api.spotifyAuthStatus,
    15000,
  );
  const { data: gemini, refresh: refreshGemini } = usePoll(
    api.geminiSettings,
    30000,
  );
  const { data: discogs, refresh: refreshDiscogs } = usePoll(
    api.discogsSettings,
    30000,
  );
  const { data: discogsAuth, refresh: refreshDiscogsAuth } = usePoll(
    api.discogsAuthStatus,
    15000,
  );
  const [saving, setSaving] = useState(false);
  /**
   * Which column last saved something needing a restart, not just "something did".
   *
   * The notice used to live only under ACCOUNTS, so toggling a permission in the other column put
   * its only confirmation somewhere you weren't looking — and since the box also appeared not to
   * move, the whole screen read as broken (#240).
   */
  const [restart, setRestart] = useState<"accounts" | "permissions" | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Run a sign-in / sign-out and say so if it fails. `AsyncButton` catches only so the click doesn't
   * throw, so without this the button settles back and nothing explains why nothing happened.
   */
  const attempt = async (fn: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await fn();
    } catch (err) {
      setProblem(errorMessage(err));
    }
  };

  const save = async (
    fn: () => Promise<{ restartRequired?: boolean }>,
    where: "accounts" | "permissions",
  ) => {
    setSaving(true);
    setProblem(null);
    try {
      const r = await fn();
      setRestart(r.restartRequired ? where : null);
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="screen">
      <header className="screen__head">
        <h1 className="pp-title screen__title">Settings</h1>
      </header>

      <div className="screen__body settings">
        <div className="settings__col">
          <section>
            <p className="pp-label settings__head">THE ROOM AND THE SERVICES</p>
            <WhichRoom />

            {/*
              The design draws all four service URLs as editable fields. They are not editable, and
              showing a box that silently does nothing would be worse than showing the value: they
              are resolved once at boot from config.toml or the environment, and `settings.json`
              sits *below* config.toml in that chain — so anything typed here could be overridden
              without a word. Making them editable is real work in three layers (ADR 0052).
            */}
            {(services?.services ?? []).map((s) => (
              <p className="setrow setrow--ro" key={s.service}>
                <span className="pp-label">
                  {s.service[0]!.toUpperCase() + s.service.slice(1)}
                </span>
                <span className="setrow__value">
                  {s.url ?? `not set — ${SERVICE_GLOSS[s.service]} is off`}
                </span>
              </p>
            ))}
            <p className="settings__note">
              Service addresses are read once at startup from{" "}
              <code>config.toml</code> or the environment. Change them there and
              restart.
            </p>
          </section>

          {/* Under the services, because it *is* one of their settings — it is what Backdrop shows
              when a record has nothing of its own (ADR 0073) — and above ACCOUNTS because you set
              it once and then forget it. */}
          <DefaultVisualizerPanel />

          <section>
            <p className="pp-label settings__head">ACCOUNTS</p>

            <Account
              name="Spotify"
              // Either is enough, so `||` not `??`: an account can be usable on app credentials
              // with no user session, and `??` only falls back on nullish — a *false* auth status
              // would report a configured account as not connected.
              connected={Boolean(spotifyAuth?.connected || spotify?.configured)}
              detail={spotifyAuth?.connected ? "signed in" : undefined}
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void save(
                    () =>
                      api.saveSpotifySettings(
                        String(f.get("clientId") ?? ""),
                        String(f.get("clientSecret") ?? ""),
                      ),
                    "accounts",
                  ).then(refreshSpotify);
                }}
              >
                <label className="setrow">
                  <span className="pp-label">CLIENT ID</span>
                  <input
                    name="clientId"
                    defaultValue={spotify?.clientId ?? ""}
                    required
                  />
                </label>
                <label className="setrow">
                  <span className="pp-label">CLIENT SECRET</span>
                  <input
                    name="clientSecret"
                    type="password"
                    placeholder="type it again — it is never sent back"
                    required
                  />
                </label>
                <button className="pp-btn" disabled={saving}>
                  SAVE
                </button>
              </form>
              {spotify?.configured && (
                <p className="account__extra">
                  {spotifyAuth?.connected ? (
                    <AsyncButton
                      className="pp-action"
                      onClick={() =>
                        attempt(() =>
                          api.spotifyDisconnect().then(refreshSpotifyAuth),
                        )
                      }
                    >
                      SIGN OUT
                    </AsyncButton>
                  ) : (
                    <AsyncButton
                      className="pp-action"
                      onClick={() =>
                        attempt(() =>
                          api
                            .spotifyLogin()
                            .then((r) => window.open(r.authorizeUrl, "_blank")),
                        )
                      }
                    >
                      SIGN IN WITH SPOTIFY
                    </AsyncButton>
                  )}
                </p>
              )}
            </Account>

            <Account name="Gemini" connected={Boolean(gemini?.configured)}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void save(
                    () =>
                      api.saveGeminiSettings({
                        apiKey: String(f.get("apiKey") ?? ""),
                      }),
                    "accounts",
                  ).then(refreshGemini);
                }}
              >
                <label className="setrow">
                  <span className="pp-label">API KEY</span>
                  <input
                    name="apiKey"
                    type="password"
                    placeholder="type it again — it is never sent back"
                    required
                  />
                </label>
                <button className="pp-btn" disabled={saving}>
                  SAVE
                </button>
              </form>
            </Account>

            <Account
              name="Discogs"
              connected={Boolean(discogsAuth?.connected || discogs?.configured)}
              detail={
                discogsAuth?.username
                  ? `as ${discogsAuth.username}`
                  : discogs?.username
                    ? `as ${discogs.username}`
                    : undefined
              }
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void save(
                    () =>
                      api.saveDiscogsSettings({
                        token: String(f.get("token") ?? ""),
                        username: String(f.get("username") ?? ""),
                      }),
                    "accounts",
                  ).then(refreshDiscogs);
                }}
              >
                <label className="setrow">
                  <span className="pp-label">USERNAME</span>
                  <input
                    name="username"
                    defaultValue={discogs?.username ?? ""}
                    required
                  />
                </label>
                <label className="setrow">
                  <span className="pp-label">PERSONAL TOKEN</span>
                  <input
                    name="token"
                    type="password"
                    placeholder="type it again — it is never sent back"
                    required
                  />
                </label>
                <button className="pp-btn" disabled={saving}>
                  SAVE
                </button>
              </form>
              {/*
               * The other way in: full OAuth, the same shape as Spotify's above. A personal token is
               * the simple default and covers the sweep, but the login exists (ADR 0017) and the
               * routes are live — an account you can only connect by curl is one nobody connects.
               */}
              {discogs?.oauthConfigured && (
                <p className="account__extra">
                  {discogsAuth?.connected ? (
                    <AsyncButton
                      className="pp-action"
                      onClick={() =>
                        attempt(() =>
                          api.discogsDisconnect().then(refreshDiscogsAuth),
                        )
                      }
                    >
                      SIGN OUT
                    </AsyncButton>
                  ) : (
                    <AsyncButton
                      className="pp-action"
                      onClick={() =>
                        attempt(() =>
                          api
                            .discogsLogin()
                            .then((r) => window.open(r.authorizeUrl, "_blank")),
                        )
                      }
                    >
                      SIGN IN WITH DISCOGS
                    </AsyncButton>
                  )}
                </p>
              )}
            </Account>

            {problem && <p className="pp-error">{problem}</p>}
            {restart === "accounts" && (
              <p className="settings__restart">
                Saved. Restart Marquee for it to take effect.
              </p>
            )}
          </section>
        </div>

        <div className="settings__col">
          <section>
            <p className="pp-label settings__head">
              WHAT ROADIE MAY DO ON ITS OWN
            </p>

            <Permission
              label="Draw card art"
              note="Cheap — about five images a go."
              on={Boolean(gemini?.generateCardArt)}
              busy={saving || !gemini}
              pinned={gemini?.generateCardArtPinned}
              onChange={(on) =>
                void save(
                  () => api.saveGeminiSettings({ generateCardArt: on }),
                  "permissions",
                ).then(refreshGemini)
              }
            />
            <Permission
              label="Make the visualizers"
              // The second sentence follows the state: "Off — Roadie just drafts the prompts" is a
              // useful thing to read under an unticked box and a plain contradiction under a ticked
              // one. It was static, and said "Off" while the box was on.
              note={
                gemini?.generateVideo
                  ? "Metered and pricey — Roadie will spend Veo credits on each one."
                  : "Metered and pricey. Off — Roadie just drafts the prompts for you."
              }
              on={Boolean(gemini?.generateVideo)}
              busy={saving || !gemini}
              pinned={gemini?.generateVideoPinned}
              onChange={(on) =>
                void save(
                  () => api.saveGeminiSettings({ generateVideo: on }),
                  "permissions",
                ).then(refreshGemini)
              }
            />
            <Permission
              label="Follow my Discogs collection"
              // From the configured interval, not a constant: the value is real and settable through
              // the API, so a hardcoded "once a day" would be wrong for anyone who has changed it.
              note={`${syncCadence(discogs?.autoSyncIntervalMinutes)} and brings new records in.`}
              on={Boolean(discogs?.autoSync)}
              busy={saving || !discogs}
              onChange={(on) =>
                void save(
                  () => api.saveDiscogsSettings({ autoSync: on }),
                  "permissions",
                ).then(refreshDiscogs)
              }
            />

            {/*
             * The Gemini flags are read at boot, so the box shows what you have *asked for* and this
             * says when it becomes true. The Discogs poller takes effect immediately and its PUT
             * reports no restart, so this stays hidden for that one.
             */}
            {restart === "permissions" && (
              <p className="settings__restart">
                Saved. Roadie picks this up when you restart Marquee.
              </p>
            )}

            {/*
              The design's fourth permission — "suggest a second palette" — is deliberately not a
              checkbox. There is no such flag, and adding one would put a Gemini call in Roadie's
              pipeline, which ADR 0027 rules out and ADR 0051 actively depends on: a sweep of a large
              Discogs collection costs nothing today precisely because no pipeline step calls an LLM.
              So it stays what it is — a button on the record — and this says so.
            */}
            <p className="settings__aside">
              <b>Suggesting a second palette</b> stays on request: ask for it
              from a record&apos;s Lights panel. Doing it for every record would
              put a paid call in Roadie&apos;s pipeline, which is the one thing
              that keeps a whole-collection sync free.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
