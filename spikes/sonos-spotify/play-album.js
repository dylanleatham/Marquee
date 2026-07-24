/**
 * Marquee spike — play a Spotify album over Sonos from code.
 *
 * Answers ONE viability question: can we, from a Node process on the LAN, make a
 * Sonos speaker play an arbitrary `spotify:album:<id>` — the thing the official
 * cloud Control API can't do (see docs/research/sonos-spotify-playback.md)?
 *
 * This is a throwaway spike, not a service. It lives outside the pnpm workspace
 * on purpose. Run it on your home network (laptop or a Pi that can see the
 * speakers) — it will NOT work from the cloud dev container, which has no Sonos
 * on its LAN.
 *
 * Usage:
 *   node play-album.js --speaker "Living Room" --album spotify:album:1DFixLWuPkv3KT3TnV35m3
 *   node play-album.js --speaker 192.168.1.42  --album https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3
 *   node play-album.js --speaker "Living Room" --stop
 *
 * How it plays a Spotify album by URI: it mimics a Sonos Spotify *favorite*.
 * Modern Sonos hides the linked account (/status/accounts is empty, cloud auth),
 * and @svrooij/sonos hardcodes the wrong service id / account serial (sid=9,
 * sn=7). So this derives the household's real sid, sn and cdudn token from an
 * existing Spotify favorite (FV:2) and builds the container URI + metadata to
 * match. Keep at least one Spotify album in Sonos Favorites (♡).
 *
 * Options:
 *   --speaker    Room name (e.g. "Living Room") OR the speaker's IP. Required to play.
 *   --album      A `spotify:album:<id>` URI or an open.spotify.com/album/<id> URL.
 *   --stop       Stop playback instead of starting.
 *   --list       List all Sonos devices with group/coordinator info, then exit.
 *   --favorites  Dump Sonos Favorites (to read sid/sn/token), then exit.
 *   --accounts   Dump raw /status/accounts, then exit.
 *   --sid --sn --token   Supply the Spotify binding explicitly (skip derivation).
 */

const http = require('http');
const { SonosManager } = require('@svrooij/sonos');

// Read the household's linked music-service accounts straight from a player's
// built-in status page (http://<ip>:1400/status/accounts, no auth). This is the
// authoritative source for the Spotify service "Type" (region code) and account
// serial number — the two values that, when mismatched, cause AddURIToQueue to
// fail with UPnP 800 even on a valid coordinator. Bounded by a short timeout so
// a slow player can't hang the run.
function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
  });
}

// Derive this household's Spotify binding by reading an existing Spotify favorite.
// A favorite carries a KNOWN-GOOD container URI (with the account's real sid + sn)
// and the cdudn token the metadata needs — the exact values @svrooij/sonos
// hardcodes wrong (sid=9, sn=7). Returns { sid, sn, token } or null if no Spotify
// favorite exists. The account-level sid/sn/token are reusable across any album.
async function deriveSpotifyBinding(device) {
  const res = await device.ContentDirectoryService.Browse({
    ObjectID: 'FV:2',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: 0,
    RequestedCount: 200,
    SortCriteria: '',
  });
  const didl = (res && res.Result) || '';
  // Locate the Spotify favorite's <res> container URI and pull sid + sn from it.
  const resMatch = didl.match(/x-rincon-cpcontainer:1004206c[^"<]*?sid=(\d+)[^"<]*?sn=(\d+)/);
  if (!resMatch) return null;
  // The account cdudn token lives in that same item's resMD, just after the res.
  const after = didl.slice(resMatch.index);
  const token = (after.match(/SA_RINCON\d+_X_#Svc\d+-0-Token/) || [])[0];
  if (!token) return null;
  return { sid: resMatch[1], sn: resMatch[2], token };
}

// ---- tiny arg parser -------------------------------------------------------
// Accepts named flags (--speaker "Living Room") AND bare positionals
// (speaker, then album). The positional fallback matters because on Windows,
// `npm run play -- --speaker X` has npm eat the --flags as its own config and
// forward only the values — so the script receives `Living Room spotify:...`
// with no flags at all. Call `node play-album.js ...` to avoid that entirely.
function parseArgs(argv) {
  const args = { stop: false };
  const positional = [];
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stop') args.stop = true;
    else if (a === '--list') args.list = true;
    else if (a === '--accounts') args.accounts = true;
    else if (a === '--favorites') args.favorites = true;
    else if (a === '--sid') args.sid = argv[++i];
    else if (a === '--sn') args.sn = argv[++i];
    else if (a === '--token') args.token = argv[++i];
    else if (a === '--speaker') args.speaker = argv[++i];
    else if (a === '--album') args.album = argv[++i];
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else positional.push(a);
  }
  // Fill unset fields from positionals, in order: speaker, then album.
  if (!args.speaker && positional.length) args.speaker = positional.shift();
  if (!args.album && positional.length) args.album = positional.shift();
  return args;
}

// ---- normalize a Spotify album reference to `spotify:album:<id>` ------------
function toSpotifyAlbumUri(input) {
  if (!input) throw new Error('--album is required unless --stop is used');
  if (input.startsWith('spotify:album:')) return input;
  // https://open.spotify.com/album/<id>?si=...  ->  spotify:album:<id>
  const m = input.match(/open\.spotify\.com\/album\/([A-Za-z0-9]+)/);
  if (m) return `spotify:album:${m[1]}`;
  throw new Error(
    `Could not parse "${input}" as a Spotify album. ` +
      'Pass spotify:album:<id> or an open.spotify.com/album/<id> URL.',
  );
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Bound the whole run so a lost speaker / bad network can't hang forever
// (Marquee rule: anything that drives the network gets a cap).
const OVERALL_TIMEOUT_MS = 30_000;

// Resolve the group coordinator for a target device. `.Coordinator` only works
// if group topology linked the coordinator object; discovery-by-name sometimes
// leaves it unset, so fall back to the device that shares this GroupId and
// reports IsCoordinator. Last resort: the device itself.
function resolveCoordinator(manager, device) {
  const direct = device.Coordinator;
  if (direct && direct.Uuid !== device.Uuid) return direct; // topology linked it
  if (device.GroupId) {
    const byGroup = manager.Devices.find((d) => d.GroupId === device.GroupId && d.IsCoordinator);
    if (byGroup) return byGroup;
  }
  return direct || device;
}

function printTopology(manager) {
  console.log(`Found ${manager.Devices.length} Sonos device(s):\n`);
  for (const d of manager.Devices) {
    const role = d.IsCoordinator ? 'COORDINATOR' : 'member';
    const coord = d.Coordinator && d.Coordinator.Uuid !== d.Uuid ? ` → coord: ${d.Coordinator.Name}` : '';
    console.log(
      `  ${d.Name}  (${d.Host})  [${role}]  group=${d.GroupName || '?'}  groupId=${d.GroupId || '?'}${coord}`,
    );
  }
  console.log('\nUse a COORDINATOR row as --speaker if a member keeps failing.');
}

async function main() {
  const args = parseArgs(process.argv);
  const manager = new SonosManager();

  // Static IP is the reliable path (loads full topology from that device);
  // discovery is the convenience path. --list without a speaker uses discovery.
  if (args.speaker && IPV4.test(args.speaker)) {
    await manager.InitializeFromDevice(args.speaker);
  } else {
    await manager.InitializeWithDiscovery(10);
  }

  if (!manager.Devices.length) {
    throw new Error('No Sonos devices found on this network. Are you on the same LAN?');
  }

  if (args.list) {
    printTopology(manager);
    return;
  }

  if (!args.speaker) throw new Error('--speaker is required (room name or IP). Try --list first.');

  const device = IPV4.test(args.speaker)
    ? manager.Devices.find((d) => d.Host === args.speaker) || manager.Devices[0]
    : manager.Devices.find((d) => d.Name.toLowerCase() === args.speaker.toLowerCase());

  if (!device) {
    const names = manager.Devices.map((d) => `"${d.Name}"`).join(', ');
    throw new Error(`No speaker named "${args.speaker}". Found: ${names}`);
  }

  // Queue commands must go to the group COORDINATOR. If the target is a grouped
  // or bonded speaker (e.g. a stereo pair, or joined to another room), sending
  // AddUriToQueue to the member fails with UPnP 800 "not a coordinator".
  const coordinator = resolveCoordinator(manager, device);
  const via = coordinator.Uuid === device.Uuid ? '' : ` via coordinator ${coordinator.Name}`;
  console.log(`→ target: ${device.Name} (${device.Host})${via}`);

  // Raw diagnostic: dump the household's /status/accounts verbatim so we can see
  // the real Spotify service Type and SerialNum (the sn to use).
  if (args.accounts) {
    const raw = await httpGet(`http://${coordinator.Host || device.Host}:1400/status/accounts`);
    console.log(`\n--- raw /status/accounts (${coordinator.Host || device.Host}) ---\n${raw.trim()}`);
    return;
  }

  // Browse Sonos Favorites (FV:2). On modern firmware /status/accounts is empty
  // (cloud-managed), so an existing Spotify favorite is the authoritative local
  // source for a KNOWN-GOOD container URI — its real sn and the account <desc>
  // token that AddURIToQueue needs. Create one Spotify favorite in the Sonos app
  // first (♡ on any album) if you have none.
  if (args.favorites) {
    const res = await coordinator.ContentDirectoryService.Browse({
      ObjectID: 'FV:2',
      BrowseFlag: 'BrowseDirectChildren',
      Filter: '*',
      StartingIndex: 0,
      RequestedCount: 100,
      SortCriteria: '',
    });
    const didl = (res && res.Result) || '';
    console.log(`\n--- Favorites DIDL (${res && res.TotalMatches} total) ---\n${didl}`);
    const sns = [...didl.matchAll(/sn=(\d+)/g)].map((m) => m[1]);
    const sids = [...didl.matchAll(/sid=(\d+)/g)].map((m) => m[1]);
    if (sns.length) console.log(`\n→ observed sn values: ${[...new Set(sns)].join(', ')}  (sid: ${[...new Set(sids)].join(', ')})`);
    else console.log('\n→ no Spotify favorites found — add one in the Sonos app, then re-run.');
    return;
  }

  if (args.stop) {
    await coordinator.Stop();
    console.log('■ stopped');
    return;
  }

  const uri = toSpotifyAlbumUri(args.album);
  const albumId = uri.replace('spotify:album:', '');

  // The library's hardcoded sid=9/sn=7 don't match this household, and modern
  // Sonos hides the account behind cloud auth (/status/accounts is empty). So
  // derive the real sid/sn/cdudn-token from an existing Spotify favorite —
  // unless the caller supplied them explicitly.
  let binding = args.sid && args.sn && args.token ? { sid: args.sid, sn: args.sn, token: args.token } : null;
  if (!binding) {
    binding = await deriveSpotifyBinding(coordinator);
    if (!binding) {
      throw new Error(
        'Could not derive the Spotify binding: no Spotify favorite found. Add one album to Sonos ' +
          'Favorites (♡) and retry, or pass --sid --sn --token from `--favorites` output.',
      );
    }
  }
  console.log(`→ album:  ${uri}`);
  console.log(`→ binding: sid=${binding.sid} sn=${binding.sn} token=${binding.token}`);

  // Build the container URI + DIDL metadata exactly as a Sonos Spotify favorite
  // does, substituting the target album id and this household's real binding.
  const enc = `spotify%3aalbum%3a${albumId}`;
  const trackUri = `x-rincon-cpcontainer:1004206c${enc}?sid=${binding.sid}&flags=8300&sn=${binding.sn}`;
  const metadata =
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" ' +
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `<item id="1004206c${enc}" parentID="1004206c${enc}" restricted="true">` +
    '<dc:title>Marquee album</dc:title>' +
    '<upnp:class>object.container.album.musicAlbum</upnp:class>' +
    `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${binding.token}</desc>` +
    '</item></DIDL-Lite>';

  // Fresh queue → add album (explicit URI + metadata) → switch to queue → play.
  // All queue/playback operations target the coordinator (see note above).
  await coordinator.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 }).catch(() => {
    /* empty queue / not supported — ignore, the add below still works */
  });
  await coordinator.AVTransportService.AddURIToQueue({
    InstanceID: 0,
    EnqueuedURI: trackUri,
    EnqueuedURIMetaData: metadata,
    DesiredFirstTrackNumberEnqueued: 0,
    EnqueueAsNext: false,
  });
  await coordinator.SwitchToQueue();
  await coordinator.Play();

  // Confirm something is actually playing.
  const track = await coordinator.AVTransportService.GetPositionInfo({ InstanceID: 0 }).catch(
    () => null,
  );
  const title = track && track.TrackMetaData && track.TrackMetaData.Title;
  console.log(`▶ playing on ${device.Name}${title ? ` — now: ${title}` : ''}`);
}

// Hard timeout wrapper.
Promise.race([
  main(),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${OVERALL_TIMEOUT_MS}ms`)), OVERALL_TIMEOUT_MS),
  ),
])
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  });
