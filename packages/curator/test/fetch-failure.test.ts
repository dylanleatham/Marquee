// Issue #270. Every "service is down" line in Curator was built from a raw fetch rejection, and a
// timeout — which means *nothing answered from this address in time* — read as *the service isn't
// running*. On 2026-08-08 that sentence sat on screen through three unrelated faults (a stale address
// in the process env, a wifi link at 12% loss, and a sync aimed at a dead host), and each time it
// pointed debugging at the service rather than at the address, which was the actual answer twice.
//
// These tests pin the wording. They are deliberately about *what the operator reads*, because the
// failure mode here was never a crash — it was a true-sounding sentence.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describeFetchFailure } from "../src/net/fetch-failure.js";
import { AmpClient } from "../src/amp/client.js";
import { BackdropClient } from "../src/backdrop/client.js";
import { ConductorClient } from "../src/conductor/client.js";

/** The real rejection Node's fetch produces, rather than a hand-made stand-in. */
const rejectionFrom = (fn: () => Promise<unknown>): Promise<unknown> =>
  fn().then(
    () => {
      throw new Error("expected the fetch to reject");
    },
    (err: unknown) => err,
  );

/** A system error shaped the way undici wraps one: a TypeError whose `cause` carries the code. */
const systemError = (code: string): Error =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(code), { code }),
  });

describe("describeFetchFailure", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("names the address and the budget it waited when the call times out", async () => {
    // A server that accepts the connection and then says nothing — the shape of a wedged service,
    // and of a link so lossy the response never lands.
    server = createServer(() => {});
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    const err = await rejectionFrom(() =>
      fetch(url, { signal: AbortSignal.timeout(50) }),
    );

    expect(describeFetchFailure(err, url, 50)).toBe(
      `no response from ${url} within 50ms`,
    );
  });

  // The distinction that matters at 2am: an address nobody holds drops the packets and burns the
  // whole budget, while a service that is down on an address that *is* held refuses instantly.
  it("says nothing is listening when the connection is refused", async () => {
    // Bind a port, learn it, then give it up — the only reliable way to name a port that is
    // certainly closed. (`http://127.0.0.1:1` does not work: port 1 is on fetch's blocked-ports
    // list, so the request fails with "bad port" without ever reaching the network.)
    const closed = createServer(() => {});
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((r) => closed.close(() => r()));
    const url = `http://127.0.0.1:${port}`;

    const err = await rejectionFrom(() =>
      fetch(url, { signal: AbortSignal.timeout(2000) }),
    );

    expect(describeFetchFailure(err, url, 2000)).toBe(
      `${url} refused the connection — nothing is listening there`,
    );
  });

  it("reports no route to the host separately from a refusal", () => {
    const url = "http://192.168.1.51:4740";
    expect(describeFetchFailure(systemError("EHOSTUNREACH"), url, 5000)).toBe(
      `no route to ${url}`,
    );
  });

  it("reports a name that will not resolve as a name problem", () => {
    const url = "http://backdrop.local:4740";
    expect(describeFetchFailure(systemError("ENOTFOUND"), url, 5000)).toBe(
      `cannot resolve the host in ${url}`,
    );
  });

  it("keeps the raw message for anything it does not recognise, still naming the address", () => {
    const url = "http://127.0.0.1:4740";
    expect(describeFetchFailure(new Error("socket hang up"), url, 5000)).toBe(
      `socket hang up (${url})`,
    );
  });

  it("calls a deliberate cancellation cancelled, not a failure", () => {
    const ac = new AbortController();
    ac.abort();
    const err = new DOMException("This operation was aborted", "AbortError");
    expect(describeFetchFailure(err, "http://127.0.0.1:4740", 5000)).toBe(
      "cancelled",
    );
  });

  // curator-ui-ux §8.5: an error is a sentence everywhere except the System page's stop control,
  // which keeps the raw code because paraphrasing it takes away the string you paste into a search.
  // Both halves matter, so the sentence and the token travel together rather than one replacing the
  // other — this fix would otherwise have quietly deleted a documented affordance.
  it("keeps the raw code greppable when the caller asks for it", () => {
    const url = "http://127.0.0.1:4737";
    expect(
      describeFetchFailure(systemError("ECONNREFUSED"), url, 5000, {
        includeCode: true,
      }),
    ).toBe(
      `${url} refused the connection — nothing is listening there (ECONNREFUSED)`,
    );
  });

  it("leaves the code off by default, so every other surface reads as a sentence", () => {
    const url = "http://127.0.0.1:4737";
    expect(
      describeFetchFailure(systemError("ECONNREFUSED"), url, 5000),
    ).not.toMatch(/ECONNREFUSED/);
  });

  // The regression itself: whatever the wording becomes, a timeout must never assert that the
  // service is down or absent. That claim is what sent the 2026-08-08 session to journalctl on a
  // service that was healthy and fast.
  it("never claims the service is down when all it knows is that nothing answered", () => {
    const err = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    const msg = describeFetchFailure(err, "http://192.168.1.49:4737", 5000);

    expect(msg).not.toMatch(/is it running/i);
    expect(msg).not.toMatch(/not reachable|unreachable/i);
    expect(msg).not.toMatch(/is down|not running/i);
    // And it does say the thing that was actually true, including the address to check.
    expect(msg).toContain("http://192.168.1.49:4737");
  });
});

// Each client wraps its own transport failures, so that every downstream reader — an album's
// syncIssue, a job's `error`, a route's 502 — inherits a message naming the service and the address
// without each of them having to remember to build one. The prefixes are pinned here because they
// are what a human actually reads when a sync fails, and nothing else asserts their shape: a
// runtimeSync failed today with a bare `The operation was aborted due to timeout`, naming neither
// Backdrop nor the address it had spent six minutes on (issue #270).
describe("service clients describe their own transport failures", () => {
  /** A port that is certainly closed: bound to learn the number, then released. */
  const closedPortUrl = async (): Promise<string> => {
    const s = createServer(() => {});
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const { port } = s.address() as AddressInfo;
    await new Promise<void>((r) => s.close(() => r()));
    return `http://127.0.0.1:${port}`;
  };

  const messageOf = async (fn: () => Promise<unknown>): Promise<string> => {
    const err = await fn().then(
      () => {
        throw new Error("expected the call to reject");
      },
      (e: unknown) => e,
    );
    return (err as Error).message;
  };

  it("Backdrop names itself, the call, and the address", async () => {
    const url = await closedPortUrl();
    const msg = await messageOf(() => new BackdropClient({ url }).getLibrary());
    expect(msg).toBe(
      `Backdrop GET /api/library: ${url} refused the connection — nothing is listening there`,
    );
  });

  it("Conductor names itself, the call, and the address", async () => {
    const url = await closedPortUrl();
    const msg = await messageOf(() =>
      new ConductorClient({ url }).listAssets(),
    );
    expect(msg).toBe(
      `Conductor GET /api/album-assets: ${url} refused the connection — nothing is listening there`,
    );
  });

  it("Amp names itself, the call, and the address", async () => {
    const url = await closedPortUrl();
    const msg = await messageOf(() => new AmpClient({ url }).status());
    expect(msg).toBe(
      `Amp GET /api/status: ${url} refused the connection — nothing is listening there`,
    );
  });
});
