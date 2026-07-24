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
 * Options:
 *   --speaker  Room name (e.g. "Living Room") OR the speaker's IP. Required.
 *   --album    A `spotify:album:<id>` URI or an open.spotify.com/album/<id> URL.
 *   --stop     Stop playback instead of starting.
 *   --region   Sonos Spotify service region id. Default 3079 (US). EU is 2311.
 *              (Wrong region is the usual cause of "it queues but won't play".)
 */

const http = require('http');
const { SonosManager, MetaDataHelper } = require('@svrooij/sonos');

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

// Sonos "Type" codes for the Spotify service (region-encoded). Matching these
// identifies the Spotify account among all linked services.
const SPOTIFY_TYPES = new Set(['2311', '3079', '9223', '12']);

async function detectAccounts(host) {
  const body = await httpGet(`http://${host}:1400/status/accounts`);
  const blocks = body.match(/<Account\b[\s\S]*?<\/Account>/g) || [];
  return blocks.map((b) => ({
    type: (b.match(/Type="(\d+)"/) || [])[1],
    serial: (b.match(/SerialNum="(\d+)"/) || [])[1],
    user: (b.match(/<UN>([^<]*)<\/UN>/) || [])[1] || '',
  }));
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
    else if (a === '--speaker') args.speaker = argv[++i];
    else if (a === '--album') args.album = argv[++i];
    else if (a === '--region') args.region = argv[++i];
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

  // MetadataHelper reads the region from this env var; default to US.
  process.env.SONOS_REGION_SPOTIFY = args.region || process.env.SONOS_REGION_SPOTIFY || '3079';

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

  if (args.stop) {
    await coordinator.Stop();
    console.log('■ stopped');
    return;
  }

  // Ground-truth the Spotify binding from the player itself, and align the
  // region to the real account Type unless the user forced one with --region.
  try {
    const accounts = await detectAccounts(coordinator.Host || device.Host);
    const summary = accounts.length
      ? accounts.map((a) => `Type=${a.type} sn=${a.serial || '?'} ${a.user}`.trim()).join(' | ')
      : '(none linked)';
    console.log(`→ accounts: ${summary}`);
    const spotify = accounts.find((a) => SPOTIFY_TYPES.has(a.type)) || (accounts.length === 1 ? accounts[0] : undefined);
    if (!accounts.length) {
      console.log('  ⚠ no music-service accounts linked — add Spotify in the Sonos app first.');
    } else if (spotify && spotify.type && !args.region) {
      process.env.SONOS_REGION_SPOTIFY = spotify.type;
      console.log(`→ using detected Spotify Type ${spotify.type} as region (account sn=${spotify.serial || '?'})`);
    }
  } catch (e) {
    console.log(`→ accounts: (could not read /status/accounts: ${e.message})`);
  }

  const uri = toSpotifyAlbumUri(args.album);
  console.log(`→ album:  ${uri}  (region ${process.env.SONOS_REGION_SPOTIFY})`);

  // Show the internal Sonos URI we generate — useful when debugging a
  // "queues but won't play" region mismatch. Best-effort: never let a
  // diagnostic block the actual playback below.
  try {
    const guessed = MetaDataHelper.GuessMetaDataAndTrackUri(uri, process.env.SONOS_REGION_SPOTIFY);
    console.log(`→ sonos uri: ${guessed.trackUri}`);
  } catch (e) {
    console.log(`→ sonos uri: (skipped diagnostic: ${e.message})`);
  }

  // Fresh queue → add album → point playback at the queue → play.
  // All queue/playback operations target the coordinator (see note above).
  await coordinator.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 }).catch(() => {
    /* empty queue / not supported — ignore, the add below still works */
  });
  await coordinator.AddUriToQueue(uri);
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
