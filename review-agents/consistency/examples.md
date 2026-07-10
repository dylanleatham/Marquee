## Good finding (info)

A new module uses `snake_case` filenames while every sibling in the package is `kebab-case`.

```json
[
  {
    "severity": "info",
    "file": "packages/curator/src/album_store.ts",
    "line": 1,
    "message": "Sibling modules use kebab-case filenames (album-detail.ts, queue-view.ts); this file uses snake_case.",
    "suggestion": "Rename to album-store.ts for consistency."
  }
]
```

## Good finding (info)

New code logs with bare `console.log` while the package uses a structured logger.

```json
[
  {
    "severity": "info",
    "file": "packages/hue-conductor/src/playback.ts",
    "line": 88,
    "message": "This uses console.log while the rest of the service logs via the Fastify logger (req.log/app.log).",
    "suggestion": "Use the structured logger so journalctl output stays consistent."
  }
]
```

## False positive to avoid

The first file in a brand-new package can't be inconsistent with siblings that don't exist yet,
and Prettier-owned formatting isn't your concern. Respond `[]`.
