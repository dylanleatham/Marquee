## Good finding (block)

Diff changes `scan-event.schema.json` to make `readerId` required.

```json
[
  {
    "severity": "blocking",
    "file": "packages/contracts/schemas/scan-event.schema.json",
    "line": 14,
    "message": "Making readerId required breaks Stylus, which omits it for single-reader installs, and any existing consumer that doesn't send it.",
    "suggestion": "Keep readerId optional with a default of \"primary\", or bump version and update all producers."
  }
]
```

## Good finding (block)

`palette-payload.schema.json` removes `\"crossfade\"` from the pattern enum, but
`packages/hue-conductor` still dispatches a crossfade pattern.

```json
[
  {
    "severity": "blocking",
    "file": "packages/contracts/schemas/palette-payload.schema.json",
    "line": 40,
    "message": "Removing the crossfade pattern type breaks Conductor's playback engine, which still handles it.",
    "suggestion": "If crossfade is being retired, remove its handling in hue-conductor in the same change and bump version."
  }
]
```

## False positive to avoid

Diff adds an optional `meta.notes` string field. This is additive and optional — both sides
ignore unknown fields. Respond `[]`; do not block.
