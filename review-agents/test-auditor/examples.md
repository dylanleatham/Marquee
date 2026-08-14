## Good finding (block)

Diff adds `POST /api/playback` to hue-conductor but no test under the package exercises it.

```json
[
  {
    "severity": "blocking",
    "file": "packages/hue-conductor/src/api.ts",
    "line": 42,
    "message": "New /api/playback endpoint has no integration test; a boundary this central should be covered.",
    "suggestion": "Add an integration test that posts a palette and asserts the command sequence sent to fake-hue-bridge."
  }
]
```

## Good finding (info)

Diff adds a palette post-processor with clear invariants (in-gamut, min saturation) but only
example-based tests.

```json
[
  {
    "severity": "info",
    "file": "packages/palette-press/src/postprocess.ts",
    "line": 10,
    "message": "Post-processor invariants (in-gamut, min saturation/brightness, min contrast) are ideal for a fast-check property test.",
    "suggestion": "Add a property test asserting every output color satisfies the gamut/saturation/brightness floors."
  }
]
```

## False positive to avoid

Diff adds a 3-line type re-export or a trivial config constant. No dedicated test needed —
respond `[]`.

## Hermeticity — a test that only passes on some machines

**A fixed path two tests could both claim.** Passes alone, fails whenever the suite runs it beside
its neighbour — and the failure lands on whoever added the neighbour.

```diff
+  it("writes the sleeve to disk", async () => {
+    await saveSleeve(album, "/tmp/marquee-sleeve.png");
+    expect(existsSync("/tmp/marquee-sleeve.png")).toBe(true);
+  });
```

```json
[
  {
    "severity": "info",
    "file": "packages/curator/test/media.test.ts",
    "line": 41,
    "message": "This writes to a fixed path rather than a per-test temp directory, so it races any other test using the same name and leaves the file behind for the next run to find.",
    "suggestion": "mkdtempSync into os.tmpdir() and clean up, as the neighbouring media tests do."
  }
]
```

**Not a finding:** a test that already pins its clock, clears its own environment, writes only under
a temp directory, or uses one of the fakes in `packages/fakes/`. Hermetic is the default expectation,
not something to congratulate.
