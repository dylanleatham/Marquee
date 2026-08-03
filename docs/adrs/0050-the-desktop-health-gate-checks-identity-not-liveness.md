# ADR 0050 — The desktop health gate checks identity, not liveness

Status: accepted · Date: 2026-08-02 · Amends: [ADR 0008](0008-desktop-app-supervises-services.md)
decision 1 (adopt-vs-fork) · Package: `packages/desktop`, `packages/curator`, `packages/hue-conductor`
· Closes [#229](https://github.com/dylanleatham/Marquee/issues/229)

## Context

[ADR 0008](0008-desktop-app-supervises-services.md) had the shell **adopt** an already-running
service instead of forking a duplicate onto a taken port. The test for "already running" was
`GET /healthz` answering 200.

That test cannot do the job it was given. A 200 proves _something_ is listening on 4739; it says
nothing about _what_. The three cases below were indistinguishable to it:

1. the Curator this launch forked,
2. a Curator from another checkout, on a different data dir and a different build,
3. any HTTP server at all that answers 200 on that path.

On 2026-08-02 case 2 happened for real: a leftover `tsx watch src/server.ts` held 4739, the packaged
app adopted it, and the window opened looking entirely normal — with no curator child anywhere in its
own process tree. The app was editing another checkout's collection, and nothing said so.

The damage is the same shape as the [#164 update to ADR 0008](0008-desktop-app-supervises-services.md):
the shell pins `MARQUEE_DATA_DIR` on Curator and `ALBUM_ASSETS_DIR` on Conductor precisely so the two
agree by construction. An adopted foreign service ignores every one of those pins. The pair
desynchronise again, by a different route.

There was a second, adjacent path to the same end state. If the port was free at probe time and taken
by the time our fork called `listen`, the child died of `EADDRINUSE` — and while that exit _was_
reported, `waitForHealth` was then satisfied by whoever won the race. Boot resolved, the window
opened, and the user got a "service stopped — restart the app" dialog on top of it. Restarting never
helped: the port was still taken.

## Decision

**The gate identifies the service before it will use it, and a service that dies during boot fails
the boot.** Concretely:

1. **A per-launch instance token.** The shell generates one (`newInstanceId()`), passes it to every
   child as `MARQUEE_INSTANCE_ID`, and requires it back. Both services echo it from `/healthz` as
   `instance`, `null` when no shell started them — a hand-run dev server or the Pi, which is exactly
   the "not ours" answer.

2. **`/healthz` says what it is and where it lives.** Curator adds `service: "curator"` and its
   resolved `dataDir`; Conductor adds `service: "hue-conductor"` and its resolved `albumAssetsDir`.
   Those are the directories the shell pins, so they are the directories the gate makes the service
   vouch for. Both additions are backward-compatible — existing fields are untouched.

3. **Four verdicts, not a boolean.** `probeHealth` returns `absent` / `ours` / `adoptable` /
   `foreign`, and `planBoot` sorts those into start / adopt / refuse.

4. **Adoption survives, narrowed to what was always safe.** A matching service — right kind, same
   directory, another launch — is still adopted, because that is the same collection and ADR 0008's
   dev convenience (a hand-started Conductor) is real. It is now logged: "this launch did not start
   it" is the first thing you want to know when the services misbehave.

5. **A stranger fails the boot.** Right kind but a different directory, or something else entirely,
   and the shell refuses to open the window, naming the port and both directories. This is the
   deviation from ADR 0008 decision 1, and it is deliberate: the shell cannot make that process into
   ours, and driving it is worse than not starting.

6. **A child that exits before it is healthy fails the boot** (`watchBootExit`, raced against the
   health wait). A non-JSON or non-200 squatter still reads as `absent` — we fork, and the child's
   `EADDRINUSE` exit is what reports the conflict. That keeps `probeHealth` from having to enumerate
   every possible squatter.

## Consequences

- **A port conflict is now a refusal with a message instead of a working-looking window.** Louder,
  and the loudness is the point: the old behaviour's whole problem was that it looked fine.
- **`/healthz` grew three fields on each service.** They are additive; `probeService` callers, the
  runbook's `curl` checks and the failure drills all still read what they read before. An older build
  that doesn't report `service` reads as `foreign` — correct, since a different build is exactly what
  the check is for.
- **The instance token is not a security control.** It is localhost-only, and anything that can bind
  4739 can read the token from the parent's environment. It distinguishes accidents, not attackers —
  which is the failure mode that actually happens.
- **`services.ts` keeps carrying the testable half.** `watchBootExit` lives there rather than in
  `main.ts` so the child-exit paths can be driven without Electron; `main.ts` stays glue.
- **The blind spot this closes**: `services.test.ts` only ever stood up its own stub and asked "does
  the poll notice it". _Whose_ server answered was not expressible in the suite, so the suite could
  not have caught this. It is now the thing the tests are about.

## Alternatives considered

- **Refuse every foreign instance, including matching ones.** Simpler, and it supersedes ADR 0008
  decision 1 outright — but it breaks the hand-started-Conductor flow for no safety gain, since a
  matching service is the same collection.
- **Adopt but warn.** A dialog costs nothing to dismiss, and the app would then be in exactly the
  state this ADR exists to prevent.
- **An IPC `listening` handshake** over the channel `fork` already opens. It proves our own child came
  up, but says nothing about what is already on the port — so the adopt probe would have stayed blind.
  The token covers both halves with one mechanism.
