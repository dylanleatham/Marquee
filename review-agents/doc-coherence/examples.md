## Real findings

**A count changed in one document and not the other** — the #260 shape. The finding names the file
that is now stale, not the file that was edited.

```diff
-The Pi 5's address is set in three places, and DHCP will move it.
+The Pi 5's address is set in two places, and DHCP will move it.
```

Possibly related: `docs/bring-up-checklist.md` lists three locations to update.

```json
[
  {
    "severity": "info",
    "file": "docs/bring-up-checklist.md",
    "line": 44,
    "message": "The runbook now says the Pi 5's address is set in two places, but the bring-up checklist still walks through three (hosts.json, the systemd unit, and the kiosk URL).",
    "suggestion": "Reconcile the count in both, or say which of the three stopped being an address."
  }
]
```

**A citation that names the wrong decision** — the #236 shape. Note this one has no markdown link,
so the link-resolution guard cannot see it.

```diff
-# ([ADR 0017](../../docs/adrs/0017-discogs-personal-token-and-direct-images.md) — not OAuth).
+# (ADR 0016 — not OAuth).
```

```json
[
  {
    "severity": "info",
    "file": "packages/curator/config.example.toml",
    "line": 8,
    "message": "This cites ADR 0016 for the Discogs personal-token decision, but 0016 is a Stylus decision — the Discogs one is 0017. The citation is also now a bare number rather than a link, so the link checker cannot catch it.",
    "suggestion": "Restore the linked [ADR 0017](...) citation, here and in the five source files that carry the same comment."
  }
]
```

**A status word left attached to something that now exists.**

```diff
+## Demo cuts
+A demo tag plays one chosen song from the album.
```

Possibly related: `docs/specs/curator-spec.md` — "Demo playback is **deferred**; see the out-of-scope
list."

```json
[
  {
    "severity": "info",
    "file": "docs/specs/curator-spec.md",
    "line": 212,
    "message": "curator-spec still lists demo playback as deferred and keeps it in the out-of-scope list, but this change documents it as shipped behaviour.",
    "suggestion": "Move it out of the out-of-scope list and drop the 'deferred' marker."
  }
]
```

## Not findings — reply `[]`

**A genuinely new fact.** It contradicts nothing; there is no stale copy to find.

```diff
+### Idle cost
+Measured with `scripts/idle-audit.mjs --duration 120`. Baseline: 0.4% CPU.
```

**Prose improved, fact unchanged.** Wording is not your brief.

```diff
-The reader polls the PN532 and publishes what it finds.
+The reader polls the PN532 and publishes each placement it sees.
```

**A speculative contradiction you cannot point at.** If you cannot name the file and the sentence,
you do not have a finding.

> "This port number may also be referenced in other deployment documentation."

**A missing document.** Absence of documentation is not stale documentation.

```diff
+export function computeDrift(a: Sample, b: Sample): number {
```

**A related file that merely shares vocabulary.** The "Possibly related" files were chosen by
keyword overlap, not judgement — one mentioning `runbook` and `address` while saying nothing that
contradicts the change is the normal case, not a finding.
