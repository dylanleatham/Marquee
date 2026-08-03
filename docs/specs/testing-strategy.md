# Testing Strategy

_A cross-cutting document. Read alongside every service spec. Establishes what "well-tested" means for this system and, more importantly, the patterns that make a test harness worth trusting._

## 1. What we're actually trying to build

**The goal isn't tests. The goal is earned confidence that a change didn't break anything.**

A code reviewer looking at a diff should be able to focus on architecture, design intent, and taste — not on "does this actually work." The test suite is what answers "does this actually work." If the suite can't answer that, no amount of code review can.

Three principles that follow from this:

1. **The value of a test equals the probability it catches a real regression times the cost of that regression escaping.** Tests that mirror the implementation (assertion by assertion) fail exactly when the implementation is rewritten and never when it's genuinely broken — negative value. Tests that verify a service still meets its externally-visible contract, on the other hand, catch real breakages.

2. **The suite is a specification.** Someone new to the code should be able to read the tests and understand what the service does. If tests are only comprehensible with the source open, they've been written from the inside out.

3. **Passing tests must mean "it works," not "the code compiles."** Every trusted green build is a promise. The harness's job is to make that promise credible.

Everything below is in service of these three.

## 2. Where to invest

Not every test type is worth the same. For this project, in decreasing order of value per hour invested:

| Test type                    | Where it lives                                           | What it catches                         | Cost                                     |
| ---------------------------- | -------------------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| **Contract tests**           | Every service boundary                                   | Schema drift between services           | Low, once schemas exist                  |
| **Unit tests of pure logic** | Palette post-processor, state machines, protocol parsers | Regressions in the actual computation   | Low                                      |
| **Property-based tests**     | Anywhere invariants are stronger than specific outputs   | Whole categories of bugs at once        | Medium (writing generators)              |
| **Golden-file tests**        | Palette Press outputs                                    | Unintended change in subjective results | Low (write once, review diffs on change) |
| **Integration tests**        | Each service, against its own fakes                      | I/O bugs, error handling, config        | Medium                                   |
| **End-to-end tests**         | Runtime overview scenarios                               | Cross-service protocol bugs             | High                                     |
| **Manual physical tests**    | Real hardware                                            | Everything the fakes lied about         | High but rare                            |

You'll notice this inverts the traditional pyramid, which puts unit tests at the base by volume. The traditional pyramid is right about cost, but wrong about value in multi-service systems. **Contract tests are the highest-value tests in a system with cross-service boundaries** — a schema drift between Curator and Backdrop is the class of bug that survives all local test suites, ships to production, and breaks silently at runtime.

## 3. Cross-cutting patterns

Six patterns you'll use across every service. Get these right once and they compound.

### 3.1 Test doubles for external dependencies

**Every external dependency has a hand-written fake, exported from a shared package, used by both the service's tests and other services' integration tests.**

External dependencies in this system:

- Hue Bridge → `fake-hue-bridge`
- Spotify Web API → `fake-spotify`
- PN532 NFC reader → `fake-pn532`
- Browser (for Backdrop) → Playwright headless (real browser, but scripted)
- Filesystem → mostly real; occasional `memfs` for edge cases

Two principles that make fakes worth trusting:

**Fake at the highest reasonable level.** A fake Hue bridge should be an HTTP server that speaks the CLIP v2 API, not a mock of the Node client library. Reasons: (a) it's a genuine boundary, so the fake tests the same code path as production; (b) other services can use the same fake without adopting Conductor's client library; (c) when the client library is upgraded, the tests don't need to change.

**The fake enforces the same invariants as the real thing.** Fake Hue bridge respects the 10 Hz rate limit, returns realistic error shapes, requires the same auth. If the real thing rejects a request, the fake must too. Otherwise the fake gives false confidence — tests pass, production breaks, that's the worst-case failure.

Fakes live in `packages/fakes/` in the monorepo (or as small npm packages if you go multi-repo). Each fake is its own testable unit — the fake itself has a small suite that verifies it matches the real thing's observable behavior. When a fake breaks (upstream API changes), that suite catches it before the consumers do.

### 3.2 Contract testing

**Shared schemas as the source of truth. Producer and consumer both validate against them.**

You already have the beginning of this in `integration-contract.md` (the `PalettePayload` JSON schema). Extend the pattern to every service boundary:

- `palette-payload.schema.json` — Curator → Conductor
- `scan-event.schema.json` — Stylus → Conductor, Stylus → Backdrop
- `library-entry.schema.json` — Curator → Backdrop
- `album-asset.schema.json` — Curator's on-disk format

Store them in `packages/contracts/` (or a `contracts/` folder synced between services). Version them. Ship them as an npm/pip package that every service depends on.

Two levels of contract testing:

**Schema-level:** Every request or file that crosses a service boundary is validated against the schema at both send and receive. Tests verify that valid payloads pass, invalid ones fail. Cheap, catches most drift.

**Interaction-level:** Verify that specific expected interactions work end-to-end. For example: "when Curator sends a library update to Backdrop, Backdrop returns 200 and subsequent scans for that URI succeed." This is closer to an integration test but scoped to one boundary. Tools like Pact.js exist for this, but for a five-service system you can hand-roll it in a `contracts/` test directory: spin up service B in-process, call it from a test that acts as service A.

**The bug this catches**: three months from now you rename a field in Curator's payload from `filePath` to `path` and update the schema. Curator's tests pass, Backdrop's tests pass, Backdrop's schema is outdated because someone forgot to bump the shared dep, and it silently drops writes because the field it wants is missing. Contract tests at the boundary catch this the moment the schema changes without Backdrop being updated to match.

### 3.3 Fake time

**Anything that involves timeouts, debouncing, polling loops, or scheduled state changes gets a fake clock.**

Everywhere this shows up:

- Conductor's playback engine (pattern timings, idle timeout)
- Stylus's poll loop (debounce, removal timeout)
- Backdrop's idle timeout, transition durations
- Curator's post-save hooks

Real time in tests is a trap. Tests that `sleep(2)` waiting for a debounce are slow and flaky. Tests that use fake time run in microseconds and are deterministic.

Tools: `sinon.useFakeTimers()` or Vitest's `vi.useFakeTimers()` for Node. `freezegun` or `time-machine` for Python. Both let you advance the clock synchronously.

Pattern to internalize: **never call `sleep` or `setTimeout` with a real delay inside a test.** If a test needs to wait for something, either advance a fake clock or wait for an observable state change. Real time is only allowed in end-to-end tests where the whole point is real timing.

### 3.4 Fixtures as first-class citizens

**Test data lives in a versioned `fixtures/` directory, is small, and is chosen to cover known-hard cases.**

The fixture album collection is the most important set:

| Fixture                          | Why it's here                                                             |
| -------------------------------- | ------------------------------------------------------------------------- |
| Purple Rain (Prince)             | Obvious dominant color, canonical validation                              |
| Kind of Blue (Miles Davis)       | Obvious color, different genre                                            |
| The White Album (Beatles)        | Nearly monochrome — challenges the post-processor                         |
| Metallica (Black Album)          | Truly monochrome — post-processor should return "insufficient" gracefully |
| Rumours (Fleetwood Mac)          | Muted, complex — realistic middle-of-the-road case                        |
| Unknown Pleasures (Joy Division) | Black-and-white, iconic, hardest realistic case                           |
| A recent color-rich album        | So you know current-era art is handled                                    |
| A recent grayscale/minimal album | So you know current-era minimalism is handled                             |

Each fixture is: the album ID (as a Spotify URI), a small copy of the artwork (in `fixtures/artwork/`), a golden palette output (in `fixtures/palettes/`), and any relevant metadata.

Not every test uses every fixture. But every test uses fixtures from this set rather than random or invented ones — because the fixtures are chosen precisely to represent the space of real inputs.

Add a fixture the first time you find a regression that a specific real album caused. Never remove one. The set grows to represent the space of edge cases you've encountered.

### 3.5 Simulation endpoints as test seams

**The `POST /simulate` pattern we've been designing into services isn't a debug tool — it's a first-class part of the test harness.**

Every service that receives events from another service exposes a way to inject those events without the source being real:

- Stylus: `POST /simulate-scan` (already spec'd for dev use)
- Backdrop: `POST /api/admin/simulate-scan` (already spec'd)
- Conductor: needs the equivalent
- Curator: less critical (its inputs are HTTP APIs already, no impersonation needed)

These endpoints exist in every environment (development, test, sometimes prod behind auth). Their value:

**In unit/integration tests**, they let you drive the service's state machine without running the upstream. Test-a-Backdrop-response-to-scan doesn't require an Stylus stub — just call `simulate-scan` directly.

**In end-to-end tests**, they let you script scenarios that would be impractical with real hardware. "Scan album A, wait 30 seconds, scan album B, wait 90 minutes (fake time), verify idle" is a five-line test.

**In manual debugging**, they let you reproduce customer-reported behavior quickly.

**In staging / demo prep**, they let you smoke-test the runtime chain without touching a record.

Cost: an extra endpoint per service. Benefit: an order of magnitude cheaper e2e testing. This is the highest ROI pattern in the doc.

### 3.6 Property-based testing where outputs have invariants

Traditional example-based tests specify: "for this input, expect this output." Property-based tests specify: "for any valid input, this invariant should hold." When the invariant is stronger than any specific output, property tests are a huge win.

Where they apply here:

**Palette post-processor** — for any album art image, the output palette must (a) contain only colors in the Hue color gamut, (b) have all colors above minimum saturation/brightness thresholds, (c) contain 1–5 colors, (d) have no two colors closer than ΔE 15. These are invariants; any input violating them is a bug. `fast-check` generates hundreds of random image tests per run and shrinks failing cases to their minimal reproductions.

**PalettePayload validator** — for any object that validates against the schema, Conductor must not crash. For any object that doesn't validate, it must return a helpful 400. Property tests generate both categories and verify.

**NFC state machine** — for any sequence of tag-present / tag-absent readings, the state machine must never enter an invalid state, and must always eventually reach IDLE if the input eventually shows no tag. This kind of "safety and liveness" property is exactly what property-based tests are good at.

Where they don't apply: anything where the expected output is a specific concrete value (Spotify API mappings, UI rendering). Example-based tests are more natural there.

## 4. Per-service strategy

Each service has the same shape but different emphasis based on what's most likely to break.

### 4.1 Palette Press (library)

**This is the most testable component in the system**: pure functions, no I/O, deterministic, easy to reason about.

- **Unit tests**: post-processor rules individually (gamut clamping, saturation boost, contrast filter, role assignment).
- **Property tests** (§3.6) for the post-processor invariants.
- **Golden files**: for each fixture album, a checked-in palette JSON. Test runs extraction, compares to golden. On intentional change, run `npm run update-goldens`, review the diff in code review.
- **No integration tests needed** — this is a library.

**Handling subjective correctness.** "Does Purple Rain look purple?" is subjective. The golden-file approach handles it well: the first time a human looks at the output and says "yes, that's Purple Rain," that becomes the golden. Any subsequent change to the output must be reviewed by a human. The test doesn't decide correctness; it detects change. Reviewer decides if change is intended.

### 4.2 Curator

Most of Curator is I/O — Spotify API calls, filesystem, HTTP posts to Backdrop. The tests reflect that shape.

- **Unit**: JSON validators, status derivation logic, filename convention parsing, the "which video files are missing" computation.
- **Integration** (real filesystem, real HTTP, in-memory SQLite): the full HTTP API against a temp directory and fake dependencies. `POST /api/albums/:id/attach-video` moves a file — verify it moved. `POST /api/backdrop/sync` calls Backdrop — verify the fake Backdrop received the correct payload.
- **Contract tests**: outbound payload to Backdrop validates against `library-entry.schema.json`. Inbound requests validate against schemas too.
- **Fixture collection tests**: run Curator's batch generate over the fixture collection, verify every fixture produces a valid asset file.

**Anti-pattern to avoid**: mocking the filesystem. Curator's whole job is filesystem manipulation; mocking `fs.writeFile` tests that Curator calls the right method, not that files end up in the right state. Use a real temp directory (`fs.mkdtemp()`) and assert on actual file contents. Costs milliseconds per test.

### 4.3 Conductor

The service most likely to have subtle time-related bugs (rate limits, patterns, idle timeout).

- **Unit**: state machine transitions, rate limiter (test that a burst of 20 commands over 1s yields exactly 10 real dispatches), palette-to-CIE conversion.
- **Integration** (fake Hue bridge, real filesystem for asset store): full API against fake bridge; verify commands sent match expected sequence.
- **Fake time is critical here.** Test that a `crossfade` pattern with `transitionMs: 12000, holdMs: 45000` produces the right sequence over 60 seconds of fake time in a millisecond of real time. Test the 90-minute idle timeout in fake time.
- **Property tests**: for any valid `PalettePayload`, the playback engine must produce a command sequence that respects rate limits. This catches "one weird payload causes a burst" bugs.
- **Contract tests**: inbound `PalettePayload` validates against schema; inbound scan event validates against schema.

### 4.4 Stylus (Python)

Python doesn't change the strategy, only the tools.

- **Unit**: state machine transitions (parametrized `pytest` cases for insert/remove/swap), NDEF parsing (given known-good NDEF bytes → expected URI), config validation.
- **Integration** (fake PN532, fake HTTP endpoints via `responses` library): the full poll loop against a scripted PN532 that returns "tag / tag / gone / gone / tag(different UID)" — verify the events published to the fakes match expectations.
- **Fake time** (`freezegun`): the entire poll loop tested at millisecond speed, using fake time to advance between polls.
- **Property tests** (`hypothesis`): random sequences of "tag present / tag absent" reads must never leave the state machine in an invalid state, must always converge to IDLE given a suffix of all-absent reads.
- **Retry logic tests**: fake HTTP endpoints that fail N times then succeed — verify retry backoff, verify give-up behavior.

**The Python service integrates with a Node-heavy ecosystem.** The contract schemas need to be readable from Python. Use `jsonschema` for validation against the same JSON files the Node services import. This is why schemas live in a language-neutral shared location, not an npm package.

### 4.5 Backdrop

The trickiest to test because it involves a browser, and browsers introduce a whole class of "runs in real Chrome but not headless" flakiness.

- **Unit** (backend Node): URI resolution, library management, state machine, WebSocket message handlers.
- **Integration** (backend against fake filesystem): API surface tested with `supertest`. Missing-file handling verified.
- **Browser tests** (Playwright headless): the SPA loaded, WebSocket connected, given a `play` command → verify the video element is playing the right file. Given a `stop` → verify fade to idle. Given rapid swap commands → verify the crossfade behavior. These are slower (real browser) but small in number — maybe 15 tests, focused on the transitions and the missing-file UX.
- **Video files in tests are tiny**: 320×240, 2 seconds, H.264 in MP4. Not the real visualizers. Test data lives in `fixtures/videos/`.
- **Fake time** for idle timeout tests.
- **Contract tests**: `/api/scan` payload against schema; `/api/library/sync` payload against schema.

**Playwright vs jsdom**: use Playwright. jsdom won't run HTML5 video. The overhead is worth it for this component.

> **Note (2026-07-29, [ADR 0040](../adrs/0040-visualizers-carry-a-decode-budget.md)).** The Playwright
> suite above is still owed, and while it was outstanding the kiosk SPA had **no** tests at all — which
> is how two playback bugs reached the hardware ([#180](https://github.com/dylanleatham/Marquee/issues/180)).
> There is now a middle tier: `packages/backdrop/test/kiosk-spa.test.ts` drives `app.js` by shadowing
> `document`/`location`/`WebSocket` as function parameters — no jsdom, no new dependency. It covers what
> is really _logic_ (which layer plays, which is paused, when roles swap, what is reported upstream) and
> deliberately does not pretend to cover rendering. "jsdom won't run HTML5 video" remains true; the
> lesson is that it was being used to justify testing _nothing_, when the orderings that actually broke
> needed no video decode to assert.

## 5. Shared infrastructure

Concretely, what to build once and reuse everywhere.

### 5.1 Layout

If you go monorepo (recommended for this project — five services with shared contracts and fakes is the poster child for one):

```
marquee/
├── packages/
│   ├── contracts/                 # JSON schemas + TS types + Python models
│   │   ├── palette-payload.schema.json
│   │   ├── scan-event.schema.json
│   │   ├── library-entry.schema.json
│   │   ├── album-asset.schema.json
│   │   ├── ts/                    # generated TS types (json-schema-to-typescript)
│   │   └── py/                    # generated Pydantic models
│   ├── fakes/
│   │   ├── fake-hue-bridge/       # runs a Fastify server that speaks CLIP v2
│   │   ├── fake-spotify/
│   │   ├── fake-crate-keeper/
│   │   └── fake-pn532/            # Python — imported by Stylus tests
│   ├── palette-press/             # the library
│   ├── curator/
│   ├── hue-conductor/
│   ├── backdrop/
│   └── nfc-trigger/               # Python
├── fixtures/
│   ├── artwork/                   # small copies of fixture album art
│   ├── palettes/                  # golden palette outputs
│   ├── videos/                    # tiny test videos
│   └── ndef/                      # NDEF byte fixtures for NFC tests
├── contracts-tests/               # cross-service contract tests
└── e2e/                           # end-to-end tests
```

If monorepo isn't the choice for other reasons: `contracts` and `fakes` still need to be shared. Publish them as private packages. Same shape, more overhead.

### 5.2 Fakes as first-class packages

Each fake ships with:

- Its own test suite verifying it matches the real dependency's behavior (recorded from real interactions or documented)
- Documentation of what it doesn't fake (deliberate limitations)
- A `record` mode that captures real interactions and can be replayed (useful the first time you're adding a fake)

Rule of thumb: **a fake without its own test suite is not a fake, it's a wish.**

### 5.3 Contracts as a versioned package

Schemas are the API. Bumping a schema is a breaking change (or an additive change with a compatibility guarantee). Every service pins a version of the contracts package. Cross-service tests run against multiple versions during migration windows.

At current scale, you don't need semantic versioning discipline yet — but organize the schemas so it's trivial to add later.

## 6. CI setup

GitHub Actions, matching your existing pattern from the newsletter project.

**On PR to any branch:**

1. **Contract tests first.** Fast, catch drift immediately. If these fail, nothing else runs — the whole PR is broken by definition.
2. **Unit tests per service.** Parallel, one job per service. Node services use one runner, Python service uses another.
3. **Integration tests per service.** Slower, still parallel.
4. **Coverage report** posted as a PR comment. Not enforced as a threshold — the moment you enforce coverage as a number, people write tests to hit the number, not to catch bugs. Coverage is a signal; investigate drops but don't gate on them.

**On merge to main:** 5. **End-to-end tests.** Spin up all services in Docker Compose (or as sibling Node/Python processes), run the runtime overview scenarios. Slower, more flaky, worth it for the higher-value validations.

**Nightly:** 6. **The fake-vs-real audit.** Run each fake's own test suite against the real dependency (real Hue bridge in a lab environment, real Spotify sandbox, etc.). Catches upstream drift. Alerts, doesn't gate.

**Not in CI:**

- Physical tests. There's no substitute; document them as a manual checklist run before demos and major releases.
- Chaos / soak tests. Worth running periodically once the system has been in real use for a while.

## 7. The confidence chain

What does "green build = safe to merge" actually rely on? A reviewer relying on this should be able to answer these:

- **Do the contracts still match?** Contract tests.
- **Does each service's own behavior still meet its spec?** Unit + integration tests, per-service.
- **Do the services still cooperate correctly at protocol level?** Cross-service contract tests.
- **Are known-hard inputs still handled correctly?** Fixture-driven tests.
- **Does the runtime chain still work end-to-end?** E2E tests (on merge, not on every PR).
- **Are the fakes still faithful to the real dependencies?** Nightly fake-vs-real audit.

What still relies on humans, even with a green build:

- Physical correctness on real hardware (LED patterns, sleeve positioning, TV connection quirks)
- Subjective quality changes (a golden palette shifted — is the new one better or worse?)
- Performance under real load. **Idle** cost is the exception — it has a measured baseline and
  budgets ([idle-cost-baseline.md](idle-cost-baseline.md)), so "is it costing more than it should
  when nothing is happening?" is answerable in one command rather than by feel. Under _load_ it is
  still a human call.
- Anything above the abstraction level of individual services (does the _system_ feel good?)

The point of the harness isn't to eliminate human judgment. It's to concentrate human judgment on things that require it, and free it from things that don't.

## 8. Anti-patterns to name and avoid

- **Assertion mirroring.** Tests that assert the same expression they compute. They pass whenever the code doesn't throw. Zero value.
- **Mocking the thing you're testing.** Curator's test that mocks the file writer doesn't test Curator. It tests that Curator calls a mock.
- **Coverage as a target.** Once coverage is a number to hit, tests get written for coverage, not correctness. Coverage is diagnostic, not prescriptive.
- **Flaky tests silently retried.** A test that fails one in twenty runs is a bug in the test or the code. Retrying it hides one of them.
- **The "kitchen sink" fixture.** A single fixture that tries to cover every case is a fixture that covers no case well. Multiple targeted fixtures beat one comprehensive fixture.
- **Snapshot testing anything that changes.** Snapshots are golden files. Golden files are only useful when changes are meaningful and reviewable. Snapshotting a rendered UI that shifts every time Tailwind updates is a way to make everyone hate testing.
- **Testing what the framework does.** Fastify handles JSON parsing correctly. You don't need to test that.
- **Test data invented at test time.** Random values inside tests obscure intent. Named fixtures document intent. There's a small role for property-based generators (§3.6), but that's structured randomness with a purpose.
- **Testing the private API.** If a private function needs a test, either it's actually part of the public interface (make it so) or you're testing implementation, not behavior. Refactoring should break tests only when it breaks something visible.

## 9. Phasing decisions

Not every test is worth writing on day one. Investment should follow discovery — build what catches real regressions, defer what's speculative.

**Worth writing from day one** (they compound too much to skip):

- Contract schemas + validators
- Fakes for external dependencies
- Fixture album collection + golden palettes
- Unit tests for pure logic (state machines, post-processor)
- Fake-time discipline in code from the start (makes retrofitting tests trivial)
- Simulate endpoints in every service

**Worth adding when the shape becomes clear** (usually after seeing the first real regression in that area):

- Exhaustive property-based tests
- Full e2e scenarios in CI
- Nightly fake-vs-real audit
- Cross-version contract migration tests

**Worth adding when scale or duration justifies the effort:**

- Chaos testing (once the runtime services have earned trust and you want to break them intentionally)
- Load testing (unlikely to matter for a home system, but relevant if the design ever grows)
- Performance regression tests (once a real regression has cost real time). **Idle cost was
  evaluated for this and deliberately declined** — the deltas that matter are tenths of a percent of
  one core, well under CI runner noise, and the measurement is wall-clock-bound by construction. It
  is a reviewer rule plus two static assertions instead
  ([ADR 0049](../adrs/0049-idle-cost-is-a-measured-baseline-not-a-ci-gate.md)).
- Soak tests (for the always-on runtime services once they've been running long enough to reveal slow leaks)

The "worth building now" bar: does this test catch a class of bug that would ruin an evening if it shipped? Yes → write it. No → wait.

## 10. What this looks like in the first week

A concrete starting kit, if you're staring at an empty repo:

1. Create the monorepo skeleton (§5.1). Empty packages, but the layout is in place.
2. Copy the existing `integration-contract.md` schema into `packages/contracts/palette-payload.schema.json`. Generate TS types from it. Have Curator and Conductor import from this one file.
3. Write `fake-hue-bridge`: a Fastify server that accepts CLIP v2 requests, tracks fake bulb state in memory, respects rate limits, returns realistic errors. Ship its own test suite (verifying it matches CLIP v2 docs).
4. Set up fixtures: 8 album art JPGs, 8 empty palette JSONs (to be filled by the first real Palette Press run).
5. Write Palette Press's first golden test: run against a fixture, save the output as the golden, mark it reviewed. First failing test comes when the algorithm changes.
6. GitHub Actions: contract validation on every PR. Fast and immediately valuable.

That's a week of infrastructure work that pays for itself in the second week and every week after.

---

## 11. A note on the training exercise framing

You called this a training exercise, and there's one meta-pattern worth naming explicitly.

**The reason strong test harnesses feel expensive is that their return curve is exponential.** The first test costs a lot of setup (fakes, fixtures, contracts) and catches almost nothing. The hundredth test catches many real bugs and costs almost nothing to add. Most projects give up before the curve inflects.

The way to make the curve inflect faster is to **treat the shared infrastructure as the first-class deliverable**, not as scaffolding for tests. Fakes, contracts, and fixtures aren't overhead — they're the harness. Once they exist, tests are trivial to write. Without them, every test is an ordeal.

If you internalize one thing from this document, let it be that: the harness is the assets that make tests cheap. The tests themselves are a byproduct.
