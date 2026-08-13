# ADR 0078 — A demo cut plays as a position in its album, because Sonos will not start a track handed to it alone

Status: accepted · Date: 2026-08-12 · Amends:
[ADR 0058](0058-a-demo-tag-plays-one-chosen-track.md) §2 (Amp no longer hands Sonos the track URI),
[amp-spec.md](../specs/amp-spec.md) (§9 scan handling, §10 the Sonos sequence, §13 the driver port) ·
Builds on [ADR 0034](0034-amp-sonos-playback-and-card-uri.md) (the queue sequence this reuses) ·
Relates: [ADR 0081](0081-an-edit-that-changes-what-the-room-plays-pushes-it.md) (the other half of
[#304](https://github.com/dylanleatham/Marquee/issues/304) — the cut never reaching the runtime at all)

## Context

With the cut finally reaching Amp ([ADR 0081](0081-an-edit-that-changes-what-the-room-plays-pushes-it.md)), demo tags still made no sound. Amp resolved the
choice, handed Sonos `spotify:track:1eTaznNW4Xxtx9za2SMTXB`, reported `action: "playing"`, and the
room stayed silent. Nothing failed: no exception, no UPnP fault, no warning in the log.

Asking the speaker directly is what settled it. On the maintainer's household (Premium account,
Living Room, ungrouped, volume 50, unmuted), with the cut enqueued exactly as Amp enqueues it:

| Probe                                                                | Result                                          |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| `GetMediaInfo` after Amp's play                                      | `NrTracks: 1` — the track _is_ in the queue     |
| `GetPositionInfo`                                                    | `Track: 1`, `TrackDuration: 0:02:39` — resolved |
| `GetTransportInfo`                                                   | **`STOPPED`**                                   |
| `Play()` again                                                       | returns `true`; still **`STOPPED`**             |
| Re-enqueue with the household's real `sid`/`sn`, `Seek` to 1, `Play` | **`STOPPED`**                                   |
| `SetAVTransportURI` straight to the track, `Play`                    | **`STOPPED`**                                   |
| Album container, `Seek(TRACK_NR, 4)`, `Play`                         | **`PLAYING`**, `DENIAL IS A RIVER`, 0:00:02     |

Sonos knows the track, knows its length, accepts it into the queue, accepts `Play`, answers `true` —
and does not start it. The same track URI plays the moment it arrives as a **position inside the
album container**; Sonos then reports the byte-identical `x-sonos-spotify:…?sid=12&flags=8232&sn=1`
as the current track. So this is not the account, the binding, the region, the `sid`/`sn` patch of
[ADR 0058](0058-a-demo-tag-plays-one-chosen-track.md), the group topology, or the volume. It is the shape of the hand-off.

This was invisible for exactly the reason ADR 0058 accepted a fallback in the first place: it argued
that a demo tag must never be silent, because silence sends you to `journalctl` while a wrong record
is a wrong you can hear and fix. The mechanism it chose was itself silent, and there was no
`journalctl` entry to go to.

## Decision

**Amp plays a demo cut by handing the driver the album and a 1-based track number.** The driver
enqueues the album container — the sequence [ADR 0034](0034-amp-sonos-playback-and-card-uri.md) already proved on this hardware — and issues
`Seek({ Unit: "TRACK_NR" })` between `SwitchToQueue` and `Play`.

`SonosDriver.play(target, spotifyUri, trackNumber?)`. The position is a driver argument rather than
something encoded in the URI, because it is a fact about _how Sonos is driven_, not about what the
album is. A card passes no position and plays from the top, unchanged.

### The seek goes after `SwitchToQueue` and before `Play`

Both edges are load-bearing. Before the switch, a queue position addresses a queue that is not yet
the transport's source. After `Play`, the first second of track 1 is audible before the cut starts —
which on a tag whose entire job is "play _this_ song to a guest" is the wrong first impression.

### `trackNumber` missing falls back to the old hand-off, and says so

The cut is stored with its position (`demoTrack.trackNumber`, [ADR 0058](0058-a-demo-tag-plays-one-chosen-track.md) §2) because the picker
takes it from the tracklist, so in practice it is always there. When it is not — an older asset, a
hand-written choice — Amp hands over the bare track as before and logs at **`warn`** naming the
consequence. That path works on some households and is silent on others, and the difference now has
a line in the log instead of being a mystery about the room.

Rejected: **refusing to play a cut with no position** (ADR 0058's whole argument against silence
applies unchanged), and **making `trackNumber` required in Curator** (it would reject a caller for a
field that is only load-bearing two services away; the warn is where the fact belongs, and the
picker already always sends it).

### The scan response now names what Sonos was given

`spotifyUri` is the album, `trackNumber` the position within it, and `demoTrack` stays the chosen
track URI. Read together they say "this album, from this song". `demoTrack` present with no
`trackNumber` is exactly the fallback above, legible to a caller without reading the log.

## Consequences

- **Demo tags make sound.** Verified on the hardware before the code was written, and again after.
- **The driver port grew a third argument**, pinned by the shared driver contract rather than only by
  the scan tests, so a second implementation has to carry it. The `Seek` call itself is in the
  hardware-coupled driver that no unit test can reach (amp-spec §13) — the probes in the table above
  are the evidence, and `AMP_SONOS_E2E=1` is how a live check is run.
- **`spotifyUri` in a demo scan response changed meaning** from the track to the album. It is a
  response field, not stored state; ADR 0058's `demoTrack` still names the cut.
- **A four-day-old symptom had two independent causes.** [#304](https://github.com/dylanleatham/Marquee/issues/304) is one report and two ADRs:
  the cut never left the workstation ([ADR 0081](0081-an-edit-that-changes-what-the-room-plays-pushes-it.md)), and once it did, the hand-off did not
  play. Fixing either alone would have left a demo tag looking exactly as broken as before, which is
  worth remembering the next time a fix "should have worked".
- **Not addressed**: whether other Spotify-on-Sonos item shapes (a playlist, a single) behave the
  same way. Only the album container and the bare track were measured, and only those two are claimed.
