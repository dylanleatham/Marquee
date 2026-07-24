/**
 * Marquee spike (Path B) — play a Spotify album on Sonos via Spotify Connect.
 *
 * This is the OFFICIAL route: it never touches Sonos's UPnP surface. It uses the
 * Spotify Web API to (1) find the Sonos speaker in your Connect device list and
 * (2) start an album context on it. Same mechanism as picking the speaker inside
 * the Spotify app — just driven by code. Contrast with ../sonos-spotify (Path A),
 * which drives Sonos's local UPnP directly.
 *
 * Requirements:
 *   - Spotify PREMIUM (Connect playback control is Premium-only).
 *   - A user access token with user-read-playback-state + user-modify-playback-state.
 *     EASIEST: if you've connected Spotify in Curator, this mints one automatically
 *     from Curator's stored PKCE refresh token (~/marquee/spotify-tokens.json) and
 *     client id (~/marquee/settings.json) — that grant already has the scopes
 *     (packages/curator DEFAULT_SCOPES). Otherwise pass --token / SPOTIFY_TOKEN.
 *   - The Sonos speaker must appear as a Connect device. It does once Spotify is
 *     linked to Sonos (you have this). Targeting it by id below also wakes it.
 *
 * Usage:
 *   node play-album.js --devices     # list Connect devices and exit
 *   node play-album.js --speaker "Living Room" --album spotify:album:1DFixLWuPkv3KT3TnV35m3
 *   node play-album.js --stop        # pause playback
 *
 * Options:
 *   --speaker        Connect device name to match (case-insensitive substring). Required to play.
 *   --album          spotify:album:<id> or an open.spotify.com/album/<id> URL.
 *   --devices        List available Connect devices and exit.
 *   --stop           Pause current playback.
 *   --token          Access token override (else SPOTIFY_TOKEN, else minted from Curator).
 *   --client-id      Spotify client id override (else SPOTIFY_CLIENT_ID, else Curator settings.json).
 *   --refresh-token  Refresh token override (else Curator spotify-tokens.json).
 *   --data-dir       Curator data dir (else MARQUEE_DATA_DIR, else ~/marquee).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
const TIMEOUT_MS = 15_000;

// Expand a leading ~ and resolve Curator's data dir (where settings.json and
// spotify-tokens.json live). Mirrors Curator's default of ~/marquee.
function resolveDataDir(args) {
  let dir = args.dataDir || process.env.MARQUEE_DATA_DIR || path.join(os.homedir(), 'marquee');
  if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
  return dir;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// Resolve a usable Spotify ACCESS token. Priority:
//   1. --token / SPOTIFY_TOKEN (a ready access token)
//   2. Mint one from Curator's stored PKCE refresh token + client id (zero setup
//      if you've connected Spotify in Curator — that grant already carries the
//      user-modify-playback-state scope, per packages/curator DEFAULT_SCOPES).
async function resolveToken(args) {
  const direct = args.token || process.env.SPOTIFY_TOKEN;
  if (direct) return direct;

  const dataDir = resolveDataDir(args);
  const settings = readJson(path.join(dataDir, 'settings.json')) || {};
  const clientId = args.clientId || process.env.SPOTIFY_CLIENT_ID || settings.spotify?.clientId;
  const tokens = readJson(path.join(dataDir, 'spotify-tokens.json'));
  const refreshToken = args.refreshToken || tokens?.refreshToken;

  if (!clientId || !refreshToken) {
    throw new Error(
      'No access token, and could not mint one. Either pass --token / set SPOTIFY_TOKEN, or ' +
        `connect Spotify in Curator so ${dataDir}\\spotify-tokens.json + settings.json exist ` +
        '(override with --client-id / --refresh-token / --data-dir).',
    );
  }
  if (tokens?.scope && !tokens.scope.includes('user-modify-playback-state')) {
    console.log('⚠ stored Spotify grant lacks user-modify-playback-state — reconnect in Curator.');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`token refresh failed (${res.status}) — ${body.error_description || body.error || 'unknown'}`);
    console.log(`→ minted access token from Curator session (${dataDir})`);
    return body.access_token;
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--devices') args.devices = true;
    else if (a === '--stop') args.stop = true;
    else if (a === '--speaker') args.speaker = argv[++i];
    else if (a === '--album') args.album = argv[++i];
    else if (a === '--token') args.token = argv[++i];
    else if (a === '--client-id') args.clientId = argv[++i];
    else if (a === '--refresh-token') args.refreshToken = argv[++i];
    else if (a === '--data-dir') args.dataDir = argv[++i];
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else positional.push(a);
  }
  if (!args.speaker && positional.length) args.speaker = positional.shift();
  if (!args.album && positional.length) args.album = positional.shift();
  return args;
}

function toAlbumUri(input) {
  if (!input) throw new Error('--album is required');
  if (input.startsWith('spotify:album:')) return input;
  const m = input.match(/open\.spotify\.com\/album\/([A-Za-z0-9]+)/);
  if (m) return `spotify:album:${m[1]}`;
  throw new Error(`Could not parse "${input}" as a Spotify album.`);
}

// Thin Spotify Web API call with a bounded timeout and useful error text.
async function api(token, method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
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
      throw new Error(`${res.status} ${res.statusText}${msg ? ` — ${msg}` : ''}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const token = await resolveToken(args);

  if (args.stop) {
    await api(token, 'PUT', '/me/player/pause');
    console.log('■ paused');
    return;
  }

  const { devices } = await api(token, 'GET', '/me/player/devices');
  if (!devices || !devices.length) {
    throw new Error(
      'No Connect devices visible. Open Spotify and cast to the Sonos speaker once so it appears, then retry.',
    );
  }

  if (args.devices) {
    console.log('Connect devices:');
    for (const d of devices) {
      console.log(`  ${d.name}  [${d.type}]  id=${d.id}  active=${d.is_active}`);
    }
    return;
  }

  if (!args.speaker) throw new Error('--speaker is required (Connect device name). Try --devices first.');

  const device = devices.find((d) => d.name.toLowerCase().includes(args.speaker.toLowerCase()));
  if (!device) {
    const names = devices.map((d) => `"${d.name}"`).join(', ');
    throw new Error(`No Connect device matching "${args.speaker}". Available: ${names}`);
  }

  const uri = toAlbumUri(args.album);
  console.log(`→ device: ${device.name} (${device.type}, id=${device.id})`);
  console.log(`→ album:  ${uri}`);

  // Target the device by id — this also transfers/wakes playback to it.
  await api(token, 'PUT', `/me/player/play?device_id=${encodeURIComponent(device.id)}`, {
    context_uri: uri,
    offset: { position: 0 },
    position_ms: 0,
  });

  // Confirm.
  const now = await api(token, 'GET', '/me/player/currently-playing').catch(() => null);
  const title = now && now.item && now.item.name;
  const artist = now && now.item && now.item.artists && now.item.artists[0] && now.item.artists[0].name;
  console.log(`▶ playing on ${device.name}${title ? ` — ${artist ? `${artist} — ` : ''}${title}` : ''}`);
}

Promise.race([
  main(),
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS + 1000)),
])
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  });
