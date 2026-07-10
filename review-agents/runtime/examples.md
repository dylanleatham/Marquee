## Good finding (block)

An outbound call to the Hue bridge has no timeout.

```json
[
  {
    "severity": "blocking",
    "file": "packages/hue-conductor/src/bridge.ts",
    "line": 51,
    "message": "fetch to the Hue bridge has no timeout; if the bridge is unreachable this hangs the request indefinitely.",
    "suggestion": "Add an AbortController timeout (the spec calls for brief retries then move on)."
  }
]
```

## Good finding (info)

An interval is started but never cleared.

```json
[
  {
    "severity": "info",
    "file": "packages/backdrop/src/idle.ts",
    "line": 20,
    "message": "setInterval for the idle-timeout check is never cleared on stop/teardown; over a long-running session these can accumulate.",
    "suggestion": "Store the handle and clearInterval when leaving PLAYING, or reuse a single timer."
  }
]
```

## False positive to avoid

A pure synchronous helper that maps hex → CIE xy has no I/O and can't hang or leak. Don't demand
try/catch around it. Respond `[]`.
