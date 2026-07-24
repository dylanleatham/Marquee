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
 *   - A user access token with scopes:
 *       user-read-playback-state  user-modify-playback-state
 *     Fastest way to get one for a spike: https://developer.spotify.com/documentation/web-api
 *     → "Get started" / the console's "Try it" gives a temporary token with scopes.
 *     (Tokens expire in ~1h — this is a spike, not the real auth. The real Amp
 *      service would use the Authorization Code + refresh flow.)
 *   - The Sonos speaker must appear as a Connect device. It does once Spotify is
 *     linked to Sonos (you have this). Targeting it by id below also wakes it.
 *
 * Usage:
 *   set SPOTIFY_TOKEN=BQ...           (PowerShell: $env:SPOTIFY_TOKEN="BQ...")
 *   node play-album.js --speaker "Living Room" --album spotify:album:1DFixLWuPkv3KT3TnV35m3
 *   node play-album.js --devices     # just list Connect devices and exit
 *   node play-album.js --stop        # pause playback
 *
 * Options:
 *   --speaker  Connect device name to match (case-insensitive substring). Required to play.
 *   --album    spotify:album:<id> or an open.spotify.com/album/<id> URL.
 *   --token    Access token (else read from SPOTIFY_TOKEN env).
 *   --devices  List available Connect devices and exit.
 *   --stop     Pause current playback.
 */

const API = 'https://api.spotify.com/v1';
const TIMEOUT_MS = 15_000;

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
  const token = args.token || process.env.SPOTIFY_TOKEN;
  if (!token) throw new Error('No token. Set SPOTIFY_TOKEN or pass --token. See header for scopes.');

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
