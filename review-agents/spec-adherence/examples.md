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

## Good finding (info) — a health endpoint that describes a check it does not perform

Both [#350](https://github.com/dylanleatham/Marquee/issues/350) and
[#351](https://github.com/dylanleatham/Marquee/issues/351) were this, in the same file. A diagnostic
endpoint's prose said what it _checks_ (`"200 when the reader is responding"`, `"the transmit drive
actually in force"`) while the handler returned a constant and a config field respectively. Nothing
in the system disagreed with the prose, so both read as working for as long as anyone believed the
sentence — in #350's case through a 40-hour outage in which every health check stayed green.

Diagnostics are the class where this matters most: they are what someone reads _instead of_ looking
at the thing, so a diagnostic that lies is worse than no diagnostic. Treat a docstring or spec
sentence naming a subject ("the reader", "the chip", "the queue") as a claim about what the code
reads, and check that the handler actually reads it.

```json
[
  {
    "severity": "info",
    "file": "packages/stylus/stylus/status_server.py",
    "line": 3,
    "message": "The docstring says GET /healthz is '200 when the reader is responding', but the handler returns a constant `{\"ok\": True}` and never consults the reader or the app.",
    "suggestion": "Report something the endpoint actually knows about the reader, or reword the line to describe what it checks."
  }
]
```

Two smells worth naming, both present in those bugs:

- **The test asserts the same constant the prose contradicts.** `assert handle(...) == (200, {"ok":
True})` is a lock, not a test: it freezes the body, so the endpoint cannot grow the signal it is
  documented as carrying without "breaking" a test that only ever checked a literal. When the code
  and its test agree and the _prose_ is the odd one out, the prose is the thing under-tested.
- **A comment that argues against the line beneath it.** `#351`'s field carried a comment explaining
  that the settings are volatile so "what the config file says is not the same question" — directly
  above a line that read the config file. A comment stating why an approach is insufficient, sitting
  on top of that approach, is a finding.

## False positives to avoid

- A stub file with `export {}` and a `// TODO: implement per spec` comment is incomplete, not
  divergent. Respond `[]`.
- "There may be other places that mention this" — if you cannot name the file and the sentence,
  it is not a finding. Respond `[]`.
