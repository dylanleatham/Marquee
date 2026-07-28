/**
 * Marquee spike — desk audio for bench preview (issue #93).
 *
 * ONE QUESTION: how does a track from the album come out of the *workstation's*
 * speakers while the producer judges a sleeve in bench preview? Three candidate
 * routes were on the table (curator-ui-ux §11); this probes the two that can be
 * settled from Node, and tells you how to settle the third:
 *
 *   A. 30-second `preview_url` clips  -> --clips     (is the field populated for
 *      THIS app's credentials? Spotify stopped issuing it to newer apps.)
 *   B. Connect transfer to the desktop Spotify client -> --devices / --play
 *      (does the workstation's own client show up, and does it start an album?)
 *   C. Web Playback SDK in-window -> needs Widevine, which stock Electron does
 *      not ship. Not answerable from Node: open widevine.html (see README).
 *
 * Like the other spikes here this is deliberately OUTSIDE the pnpm workspace and
 * has NO dependencies — Node's built-in fetch only. Throwaway by design.
 *
 * Auth: same trick as ../spotify-connect — if you've connected Spotify in
 * Curator, it mints an access token from the stored PKCE refresh token
 * (~/marquee/spotify-tokens.json) + client id (~/marquee/settings.json). The
 * grant already carries the scopes we need (packages/curator DEFAULT_SCOPES).
 *
 * Usage:
 *   node probe.js                       # run every probe and print a verdict
 *   node probe.js --clips               # A: preview_url availability
 *   node probe.js --devices             # B: list Connect devices
 *   node probe.js --play                # B: play the album at the desk
 *   node probe.js --stop                # pause whatever is playing
 *
 * Options:
 *   --album          spotify:album:<id>, an open.spotify.com/album/<id> URL, or a
 *                    Curator curatorId. Default: the first album in the asset store.
 *   --device         Connect device name to play on (case-insensitive substring).
 *                    Default: this machine's own Spotify client (type=Computer).
 *   --token          Access token override (else SPOTIFY_TOKEN, else minted).
 *   --client-id      Client id override (else SPOTIFY_CLIENT_ID, else settings.json).
 *   --refresh-token  Refresh token override (else spotify-tokens.json).
 *   --data-dir       Curator data dir (else MARQUEE_DATA_DIR, else ~/marquee).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const API = "https://api.spotify.com/v1";
const ACCOUNTS = "https://accounts.spotify.com";
const TIMEOUT_MS = 15_000;
// Every probe is a couple of round trips; --play adds a settle wait before it
// reads back what is actually playing. Bound the whole run so a hung Spotify
// call can't leave the spike sitting there (CLAUDE.md: bound the network).
const RUN_TIMEOUT_MS = 90_000;

function resolveDataDir(args) {
  let dir =
    args.dataDir ||
    process.env.MARQUEE_DATA_DIR ||
    path.join(os.homedir(), "marquee");
  if (dir.startsWith("~")) dir = path.join(os.homedir(), dir.slice(1));
  return dir;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function resolveToken(args) {
  const direct = args.token || process.env.SPOTIFY_TOKEN;
  if (direct) return direct;

  const dataDir = resolveDataDir(args);
  const settings = readJson(path.join(dataDir, "settings.json")) || {};
  const clientId =
    args.clientId ||
    process.env.SPOTIFY_CLIENT_ID ||
    settings.spotify?.clientId;
  const tokens = readJson(path.join(dataDir, "spotify-tokens.json"));
  const refreshToken = args.refreshToken || tokens?.refreshToken;

  if (!clientId || !refreshToken) {
    throw new Error(
      "No access token, and could not mint one. Either pass --token / set SPOTIFY_TOKEN, or " +
        `connect Spotify in Curator so ${dataDir} has spotify-tokens.json + settings.json ` +
        "(override with --client-id / --refresh-token / --data-dir).",
    );
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ACCOUNTS}/api/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(
        `token refresh failed (${res.status}) — ${body.error_description || body.error || "unknown"}`,
      );
    console.log(`→ minted access token from Curator session (${dataDir})`);
    console.log(`→ client id: ${clientId}`);
    if (tokens?.scope) console.log(`→ granted scopes: ${tokens.scope}`);
    return body.access_token;
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--clips") args.clips = true;
    else if (a === "--devices") args.devices = true;
    else if (a === "--play") args.play = true;
    else if (a === "--stop") args.stop = true;
    else if (a === "--album") args.album = argv[++i];
    else if (a === "--device") args.device = argv[++i];
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--client-id") args.clientId = argv[++i];
    else if (a === "--refresh-token") args.refreshToken = argv[++i];
    else if (a === "--data-dir") args.dataDir = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.clips && !args.devices && !args.play && !args.stop) args.all = true;
  return args;
}

// An album to probe with. Accepts a Spotify URI/URL, or a Curator curatorId —
// and with neither, grabs the first album in the asset store that has a Spotify
// URI, so the spike runs with no arguments at all.
function resolveAlbum(args) {
  const input = args.album;
  if (input) {
    if (input.startsWith("spotify:album:"))
      return { uri: input, from: "--album" };
    const m = input.match(/open\.spotify\.com\/album\/([A-Za-z0-9]+)/);
    if (m) return { uri: `spotify:album:${m[1]}`, from: "--album" };
  }

  const dir = path.join(resolveDataDir(args), "album-assets");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  if (input) {
    const asset = readJson(path.join(dir, `${input}.json`));
    const uri = asset?.metadata?.spotifyUri;
    if (!uri)
      throw new Error(
        `"${input}" is not a Spotify album URI/URL, and no album asset with that curatorId has a spotifyUri.`,
      );
    return { uri, from: `curatorId ${input}`, name: asset.metadata.name };
  }
  for (const f of files) {
    const asset = readJson(path.join(dir, f));
    const uri = asset?.metadata?.spotifyUri;
    if (uri)
      return {
        uri,
        from: `asset store (${asset.curatorId})`,
        name: asset.metadata.name,
      };
  }
  throw new Error(
    `No --album given and no album in ${dir} has a spotifyUri. Pass --album spotify:album:<id>.`,
  );
}

async function api(token, method, endpoint, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = JSON.parse(text).error?.message || text;
      } catch {
        /* keep raw text */
      }
      throw new Error(
        `${res.status} ${res.statusText}${msg ? ` — ${msg}` : ""}`,
      );
    }
    // Player endpoints answer 200/204 with an empty or non-JSON body (pause
    // returns an opaque string) — a successful call must not blow up here.
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } finally {
    clearTimeout(timer);
  }
}

const albumId = (uri) => uri.split(":").pop();

// ── Route A: 30-second preview_url clips ────────────────────────────────────
// The cheapest route by far (an <audio> tag, no DRM, no Premium) — IF the field
// is populated. Spotify stopped issuing preview_url to newer applications, so
// this asks the API rather than trusting the docs. Checked three ways because
// the field lives on three differently-shaped objects, and a null on one is not
// proof of a null on the others.
async function probeClips(token, album, me) {
  console.log("\n── A. 30-second preview_url clips ──────────────────────────");
  const market = me?.country || "US";
  const id = albumId(album.uri);

  const tracks = await api(
    token,
    "GET",
    `/albums/${id}/tracks?limit=50&market=${market}`,
  );
  const items = tracks.items || [];
  const withPreview = items.filter((t) => t.preview_url);
  console.log(
    `album tracks (market=${market}): ${withPreview.length}/${items.length} have preview_url`,
  );

  // The full track object, in case the simplified one omits what the full one has.
  let fullOk = false;
  if (items[0]) {
    const full = await api(
      token,
      "GET",
      `/tracks/${items[0].id}?market=${market}`,
    );
    fullOk = Boolean(full.preview_url);
    console.log(
      `full track object (${full.name}): preview_url = ${full.preview_url || "null"}`,
    );
  }

  // Search results are a third shape, and a common workaround suggestion.
  let searchOk = false;
  const search = await api(
    token,
    "GET",
    `/search?type=track&limit=5&market=${market}&q=${encodeURIComponent(items[0]?.name || "a")}`,
  );
  const hits = search.tracks?.items || [];
  searchOk = hits.some((t) => t.preview_url);
  console.log(
    `search results: ${hits.filter((t) => t.preview_url).length}/${hits.length} have preview_url`,
  );

  const viable = withPreview.length > 0 || fullOk || searchOk;
  console.log(
    viable
      ? "VERDICT A: VIABLE — clips are available to this app's credentials."
      : "VERDICT A: DEAD — preview_url is null everywhere for this app's credentials.",
  );
  return viable;
}

// ── Route B: Connect transfer to the desktop Spotify client ─────────────────
// The workstation client is already awake, so ADR 0034's reason for rejecting
// Connect for Amp (cannot wake an idle Sonos) does not apply here.
async function probeDevices(token, args) {
  console.log("\n── B. Spotify Connect devices ──────────────────────────────");
  const { devices } = await api(token, "GET", "/me/player/devices");
  if (!devices || !devices.length) {
    console.log(
      "no Connect devices visible — open the Spotify desktop app on this machine and retry.",
    );
    return { devices: [], desk: undefined };
  }
  for (const d of devices) {
    console.log(
      `  ${d.name}  [${d.type}]  id=${d.id}  active=${d.is_active}  restricted=${d.is_restricted}`,
    );
  }
  const desk = args.device
    ? devices.find((d) =>
        d.name.toLowerCase().includes(args.device.toLowerCase()),
      )
    : devices.find((d) => d.type === "Computer");
  console.log(
    desk
      ? `→ desk client: ${desk.name} [${desk.type}]`
      : args.device
        ? `→ no device matching "${args.device}"`
        : "→ no device of type Computer — the desktop Spotify client is not running here.",
  );
  return { devices, desk };
}

async function probePlay(token, album, args, me) {
  console.log("\n── B. Play the album at the desk ───────────────────────────");
  if (me && me.product !== "premium") {
    console.log(
      `account product is "${me.product}" — Connect playback control is Premium-only, expect 403.`,
    );
  }
  const { desk } = await probeDevices(token, args);
  if (!desk) {
    console.log("VERDICT B: cannot test — no desk client to target.");
    return false;
  }

  console.log(`→ album: ${album.uri}${album.name ? ` (${album.name})` : ""}`);
  await api(
    token,
    "PUT",
    `/me/player/play?device_id=${encodeURIComponent(desk.id)}`,
    { context_uri: album.uri, offset: { position: 0 }, position_ms: 0 },
  );

  // Spotify reports the new context asynchronously; give it a beat before reading back.
  await new Promise((r) => setTimeout(r, 1500));
  const now = await api(token, "GET", "/me/player").catch(() => null);
  const item = now?.item;
  const playing = Boolean(now?.is_playing);
  console.log(
    playing
      ? `▶ playing on ${now.device?.name} — ${item?.artists?.[0]?.name} — ${item?.name}`
      : "no playback reported after the transfer.",
  );
  console.log(
    playing
      ? "VERDICT B: VIABLE — audio is coming out of the workstation."
      : "VERDICT B: INCONCLUSIVE — the call was accepted but nothing is playing.",
  );
  return playing;
}

async function main() {
  const args = parseArgs(process.argv);
  const token = await resolveToken(args);

  if (args.stop) {
    // Pausing an already-paused player is a 403 "Restriction violated", which
    // is the state we wanted, not a failure.
    try {
      await api(token, "PUT", "/me/player/pause");
      console.log("■ paused");
    } catch (err) {
      if (/Restriction violated/.test(err.message))
        console.log("■ already paused");
      else throw err;
    }
    return;
  }

  const me = await api(token, "GET", "/me").catch(() => null);
  if (me)
    console.log(
      `→ account: ${me.display_name || me.id} (${me.product}, country=${me.country})`,
    );

  const album = resolveAlbum(args);
  console.log(`→ album under test: ${album.uri} — from ${album.from}`);

  if (args.clips || args.all) await probeClips(token, album, me);
  if (args.devices && !args.play) await probeDevices(token, args);
  if (args.play || args.all) await probePlay(token, album, args, me);

  if (args.all) {
    console.log(
      "\n── C. Web Playback SDK (Widevine) ──────────────────────────",
    );
    console.log(
      "not answerable from Node — open widevine.html in the desktop app's window (see README).",
    );
  }
}

Promise.race([
  main(),
  new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Timed out after ${RUN_TIMEOUT_MS}ms`)),
      RUN_TIMEOUT_MS,
    ),
  ),
])
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  });
