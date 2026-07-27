# @marquee/observability

Structured log records and stable error fingerprints. Pure library — no I/O, no transport, no
dependencies.

Stage 2 of the error-observability pipeline
([#142](https://github.com/dylanleatham/Marquee/issues/142) /
[#144](https://github.com/dylanleatham/Marquee/issues/144)). Stage 1 gave the shell a rotating file
to write to ([#141](https://github.com/dylanleatham/Marquee/issues/141)); this gives what lands there
a shape, and gives each error an id you can group on.

## Usage

```ts
import { createLogger } from "@marquee/observability";

const log = createLogger({ service: "curator" });

log.info("listening", { port: 4739 });
log.error("Failed to start", err);
log.child("roadie").warn("art fetch retried");
```

Two output forms, because the audiences differ and neither is optional:

```
2026-07-27T20:00:00.000Z ERROR [curator] Failed to start — SyntaxError: unexpected token (eb86a62f745f)
    at startCurator (packages/curator/src/server.ts:2197:11)
```

```
MARQUEE_LOG_FORMAT=json
{"level":"error","time":"…","service":"curator","message":"Failed to start","error":{…,"fingerprint":"eb86a62f745f"}}
```

Same binary either way — a developer's `pnpm dev` and the packaged app's supervised child are the
same code, so the format is env-driven rather than a build flag.

The logger is a **builder, not a transport**. Where records go is the caller's business: the desktop
shell captures its children's stdout into the rotating file, a bare `pnpm dev` has a terminal, tests
pass an array. Supply `emit` to redirect.

## The fingerprint

The hash covers **error type + normalized stack frames**, and deliberately **not the message**.

That last part is the whole design. Messages carry the variable part of a failure — ids, paths,
counts, durations — so hashing them splits one bug across dozens of fingerprints, and a reporter
built on that either spams duplicates or drops real failures. The message still travels on the
record for humans; it just doesn't group.

Normalization is what makes two occurrences of one bug agree:

| Varies                        | Handling                                                           |
| ----------------------------- | ------------------------------------------------------------------ |
| Absolute checkout path        | Made repo-relative (`packages/curator/src/server.ts`)              |
| Windows vs POSIX separators   | Normalized — the workstation is Windows, the Pi is Linux           |
| `file://` URLs in ESM stacks  | Stripped                                                           |
| Line and column               | Dropped — an edit above the throw site must not re-key a known bug |
| pnpm's versioned path segment | Collapsed, so a dependency bump isn't a new bug                    |
| `async` / `new` call shape    | Stripped                                                           |
| Node internals                | Dropped — they describe V8's route, not the bug                    |

Application frames win over dependency frames: a failure inside `fastify` raised from two of our call
sites is two bugs, not one. Dependency frames are used only when there are no application frames at
all. When there is no usable stack (a thrown string, a stripped stack), the fingerprint falls back to
a scrubbed message — otherwise every stackless failure in the process would share one id.

### Known limits

- **Two different bugs on different lines of one function collide.** The price of dropping line
  numbers. Dropping them was the right trade: re-keying every known bug on an unrelated edit is the
  worse failure.
- **Digitless hex (`deadbeef`) isn't scrubbed** in the no-stack fallback — it's indistinguishable
  from a word.
- **`error.cause` is not walked.** A wrapped error fingerprints on the wrapper's own stack.

## Adoption

Deliberately incremental, per #142's scope notes — a shared helper plus the highest-traffic error
paths, not a big-bang rewrite of every `console.*`. Currently adopted by the boot-failure path of
each service (`amp`, `backdrop`, `curator`, `hue-conductor`), which had independently grown four
copies of the same `console.error("Failed to start X:", err)` line. The services' pino request logs
are untouched.
