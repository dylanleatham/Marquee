## Good finding (block)

A real-looking shared secret is committed in source.

```json
[
  {
    "severity": "blocking",
    "file": "packages/hue-conductor/src/config.ts",
    "line": 3,
    "message": "Hardcoded shared secret \"a91f3c...\" committed in source instead of read from config.toml/env.",
    "suggestion": "Load it from config at runtime; never commit the real value."
  }
]
```

## Good finding (block)

Backdrop builds a file path directly from the scan URI.

```json
[
  {
    "severity": "blocking",
    "file": "packages/backdrop/src/resolve.ts",
    "line": 17,
    "message": "filePath is built by concatenating the raw scan URI, allowing ../ path traversal outside the media directory.",
    "suggestion": "Resolve against the media root and reject paths that escape it; only serve entries present in library.json."
  }
]
```

## False positive to avoid

`shared_secret = "change-me-lan-only-secret"` in `config.example.toml`, or
`SPOTIFY_CLIENT_ID=your-spotify-client-id` in `.env.example`, are documented placeholders.
Respond `[]`. Also do not flag the absence of real auth — LAN-only shared-secret is the design.
