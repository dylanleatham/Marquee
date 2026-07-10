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

## False positive to avoid

A stub file with `export {}` and a `// TODO: implement per spec` comment is incomplete, not
divergent. Respond `[]`.
