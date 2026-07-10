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
