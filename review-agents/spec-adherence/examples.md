## Good finding (info)

Backdrop's `/api/scan` handler returns 200.

```json
[
  {
    "severity": "info",
    "file": "packages/backdrop/src/api.ts",
    "line": 30,
    "message": "backdrop-spec §8 says /api/scan responds 202 (accepted) so it doesn't block the trigger; this returns 200.",
    "suggestion": "Return 202, or update backdrop-spec if 200 is now intended."
  }
]
```

## Good finding (info)

Conductor uses port 4738.

```json
[
  {
    "severity": "info",
    "file": "packages/hue-conductor/src/server.ts",
    "line": 5,
    "message": "hue-conductor-spec §7 specifies port 4737; this binds 4738.",
    "suggestion": "Align the port with the spec (and the runbook), or update both docs."
  }
]
```

## Good finding (info) — doc ↔ doc

The diff updates the Pi 5's address in `deploy-runbook.md`; `parts-list.md` still carries the old
one.

```json
[
  {
    "severity": "info",
    "file": "docs/specs/parts-list.md",
    "line": 44,
    "message": "This change moved the Pi 5 to 192.168.1.42 in the runbook, but parts-list.md still says 192.168.1.40.",
    "suggestion": "Update parts-list.md, or say in the runbook which one is authoritative."
  }
]
```

## Good finding (info) — a status word left behind

```json
[
  {
    "severity": "info",
    "file": "docs/specs/curator-spec.md",
    "line": 212,
    "message": "This change implements cover upload, but curator-spec still lists it under 'Deferred'.",
    "suggestion": "Move it out of the deferred list."
  }
]
```

## False positives to avoid

- A stub file with `export {}` and a `// TODO: implement per spec` comment is incomplete, not
  divergent. Respond `[]`.
- "There may be other places that mention this" — if you cannot name the file and the sentence,
  it is not a finding. Respond `[]`.
