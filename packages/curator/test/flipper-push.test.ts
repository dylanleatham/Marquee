import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findFlipperPort,
  pushFile,
  readFile,
  oneAtATime,
  FlipperPushError,
  FLIPPER_PENDING_PATH,
  type FlipperCli,
} from "../src/tags/flipper-push.js";
import { mergePendingCsv, parsePendingCsv } from "../src/tags/pending-csv.js";
import { buildServer } from "../src/server.js";
import { AssetStore } from "../src/store/asset-store.js";
import { fakeRoadie, makeAsset } from "./helpers.js";

const ID = "2k7bxq9m";

describe("findFlipperPort", () => {
  const flipper = {
    path: "COM6",
    vendorId: "0483",
    productId: "5740",
    serialNumber: "FLIP_ALEONI5E",
  };
  const bluetooth = { path: "COM5", serialNumber: undefined };

  it("finds the Flipper by USB vendor/product id", () => {
    expect(findFlipperPort([bluetooth, flipper])).toBe("COM6");
  });

  it("accepts a 0x-prefixed or upper-case id", () => {
    expect(
      findFlipperPort([
        { path: "COM9", vendorId: "0X0483", productId: "0x5740" },
      ]),
    ).toBe("COM9");
  });

  it("falls back to the FLIP_ serial number when ids are missing", () => {
    expect(
      findFlipperPort([
        { path: "/dev/tty.usbmodem1", serialNumber: "FLIP_zed" },
      ]),
    ).toBe("/dev/tty.usbmodem1");
  });

  /** The dangerous failure: writing CLI commands into an unrelated serial device. */
  it("returns null rather than guessing at a non-Flipper port", () => {
    expect(findFlipperPort([bluetooth])).toBeNull();
    expect(findFlipperPort([])).toBeNull();
    expect(
      findFlipperPort([
        { path: "COM3", vendorId: "1a86", productId: "7523" }, // a CH340 dongle
      ]),
    ).toBeNull();
  });
});

/**
 * A simulator for the Flipper's serial CLI, not a canned-response stub.
 *
 * It models the three behaviours that actually bit us on hardware, so that class of bug is catchable
 * here instead of only at the end of a USB cable:
 *
 *   1. A **connect banner** is already in the buffer before we send anything, and it ends in a
 *      prompt. Code that reads "until the next prompt" matches the banner and returns the wrong
 *      thing — which is exactly how the Ship tab's append silently became a replace.
 *   2. Every command is **echoed** before its output. That echo is the only unique sync point.
 *   3. `write_chunk` **appends** to an existing file rather than truncating (firmware 1.4.3).
 */
const BANNER =
  "Welcome to Flipper Zero Command Line Interface!\r\n\r\n>: \r\n>: ";

interface FakeOptions {
  /** Answer `write_chunk` with an error instead of `Ready`. */
  refuseWrite?: boolean;
  /** Report this size on read-back regardless of what was written. */
  lieAboutSize?: number;
  /** Fail every read-back, even for a file that exists. */
  unreadable?: boolean;
}

function fakeFlipper(
  initial: Record<string, string> = {},
  options: FakeOptions = {},
): FlipperCli & { written: string[]; files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  const written: string[] = [];
  let buf = BANNER;
  let awaitingPayload: string | null = null;

  return {
    written,
    files,

    write: async (data) => {
      const s = data.toString("utf8");
      written.push(s);

      if (awaitingPayload !== null) {
        // The device counts bytes, and appends them to whatever is already there.
        files[awaitingPayload] = (files[awaitingPayload] ?? "") + s;
        awaitingPayload = null;
        buf += "\r\n>: ";
        return;
      }

      const line = s.replace(/\r?\n$/, "");
      buf += `${line}\r\n`; // echo
      const m =
        /^storage (mkdir|remove|read|write_chunk) (\S+)(?: (\d+))?$/.exec(line);
      if (!m) {
        buf += ">: ";
        return;
      }
      const cmd = m[1]!;
      const path = m[2]!;
      if (cmd === "mkdir") {
        buf += ">: ";
      } else if (cmd === "remove") {
        delete files[path];
        buf += ">: ";
      } else if (cmd === "read") {
        const body = files[path];
        if (body === undefined || options.unreadable) {
          buf += "Storage error: file/dir not exist\r\n>: ";
        } else {
          const size = options.lieAboutSize ?? body.length;
          buf += `Size: ${size}\r\n\n${body}\r\n>: `;
        }
      } else if (options.refuseWrite) {
        buf += "Storage error: not enough memory\r\n>: ";
      } else {
        awaitingPayload = path;
        buf += "Ready\r\n";
      }
    },

    readUntil: async (marker) => {
      const at = buf.indexOf(marker);
      if (at === -1)
        throw new FlipperPushError(
          `timed out waiting for ${JSON.stringify(marker)}`,
        );
      const seen = buf.slice(0, at + marker.length);
      buf = buf.slice(at + marker.length);
      return seen;
    },

    readCount: async (n) => {
      if (buf.length < n)
        throw new FlipperPushError(
          `timed out reading ${n} bytes (had ${buf.length})`,
        );
      const seen = buf.slice(0, n);
      buf = buf.slice(n);
      return seen;
    },

    flush: async () => {
      buf = "";
    },

    close: async () => {},
  };
}

const CSV = "curatorId,name,artist\n2k7bxq9m,Purple Rain,Prince\n";

describe("pushFile", () => {
  it("writes the chunk header, then exactly that many bytes", async () => {
    const cli = fakeFlipper();
    const res = await pushFile(cli, FLIPPER_PENDING_PATH, CSV);

    expect(res).toEqual({ bytes: Buffer.byteLength(CSV) });
    expect(cli.written).toContain(
      `storage write_chunk ${FLIPPER_PENDING_PATH} ${Buffer.byteLength(CSV)}\r\n`,
    );
    // The payload goes out as its own raw write, unterminated — the device counts bytes, not lines.
    expect(cli.written).toContain(CSV);
    expect(cli.files[FLIPPER_PENDING_PATH]).toBe(CSV);
  });

  it("creates the app-data directory before writing", async () => {
    const cli = fakeFlipper();
    await pushFile(cli, FLIPPER_PENDING_PATH, CSV);
    expect(cli.written).toContain(
      "storage mkdir /ext/apps_data/marquee_tag_writer\r\n",
    );
  });

  /**
   * `write_chunk` APPENDS on firmware 1.4.3 — pushing over an existing list left both copies (84
   * bytes onto 105 gave 189). Removing first is the only thing that makes a re-push replace.
   */
  it("replaces an existing file rather than appending to it", async () => {
    const cli = fakeFlipper({
      [FLIPPER_PENDING_PATH]: "curatorId,name,artist\nold12345,Old,Row\n",
    });
    await pushFile(cli, FLIPPER_PENDING_PATH, CSV);
    expect(cli.files[FLIPPER_PENDING_PATH]).toBe(CSV);
  });

  it("fails when the device never says it is Ready", async () => {
    const cli = fakeFlipper({}, { refuseWrite: true });
    await expect(pushFile(cli, FLIPPER_PENDING_PATH, CSV)).rejects.toThrow(
      FlipperPushError,
    );
  });

  /** Trusting the write is how a half-written list silently reaches the device. */
  it("fails when the size read back differs from what we sent", async () => {
    const cli = fakeFlipper({}, { lieAboutSize: 3 });
    await expect(pushFile(cli, FLIPPER_PENDING_PATH, CSV)).rejects.toThrow(
      /but the Flipper reports 3/,
    );
  });

  it("fails when the file cannot be read back at all", async () => {
    const cli = fakeFlipper({}, { unreadable: true });
    await expect(pushFile(cli, FLIPPER_PENDING_PATH, CSV)).rejects.toThrow(
      /could not read it back/,
    );
  });
});

describe("readFile", () => {
  it("returns the file's contents", async () => {
    const cli = fakeFlipper({ [FLIPPER_PENDING_PATH]: CSV });
    expect(await readFile(cli, FLIPPER_PENDING_PATH)).toBe(CSV);
  });

  /**
   * The regression this cost a hardware round-trip to find. The connect banner ends in a prompt, so
   * reading "until the next prompt" returned the banner and reported an empty file — turning the
   * Ship tab's append into a replace that dropped the whole list.
   */
  it("is not fooled by the connect banner sitting in the buffer", async () => {
    const cli = fakeFlipper({ [FLIPPER_PENDING_PATH]: CSV });
    const body = await readFile(cli, FLIPPER_PENDING_PATH);
    expect(body).toBe(CSV);
    expect(body).not.toContain("Welcome to Flipper Zero");
  });

  it("returns the exact bytes even when the content looks like a prompt", async () => {
    const weird = "curatorId,name,artist\n2k7bxq9m,>: weird,Prince\n";
    const cli = fakeFlipper({ [FLIPPER_PENDING_PATH]: weird });
    expect(await readFile(cli, FLIPPER_PENDING_PATH)).toBe(weird);
  });

  /** No list on the card yet is the normal first-run case, not an error. */
  it("treats a missing file as an empty list", async () => {
    const cli = fakeFlipper();
    expect(await readFile(cli, FLIPPER_PENDING_PATH)).toBe("");
  });
});

/** The whole read-modify-write, against the simulator — the merge must survive the round trip. */
describe("append round trip", () => {
  it("keeps the existing rows and adds the new one", async () => {
    const cli = fakeFlipper({ [FLIPPER_PENDING_PATH]: CSV });

    const existing = await readFile(cli, FLIPPER_PENDING_PATH);
    const merged = mergePendingCsv(existing, [
      { curatorId: "7v3mn2xd", name: "Kind of Blue", artist: "Miles Davis" },
    ]);
    await pushFile(cli, FLIPPER_PENDING_PATH, merged);

    expect(parsePendingCsv(cli.files[FLIPPER_PENDING_PATH]!)).toEqual([
      { curatorId: ID, name: "Purple Rain", artist: "Prince" },
      { curatorId: "7v3mn2xd", name: "Kind of Blue", artist: "Miles Davis" },
    ]);
  });

  it("does not grow the list when the same album is added twice", async () => {
    const cli = fakeFlipper({ [FLIPPER_PENDING_PATH]: CSV });
    const row = { curatorId: ID, name: "Purple Rain", artist: "Prince" };

    for (let i = 0; i < 2; i++) {
      const existing = await readFile(cli, FLIPPER_PENDING_PATH);
      await pushFile(
        cli,
        FLIPPER_PENDING_PATH,
        mergePendingCsv(existing, [row]),
      );
    }

    expect(parsePendingCsv(cli.files[FLIPPER_PENDING_PATH]!)).toEqual([row]);
  });
});

describe("POST /api/tags/push-to-flipper", () => {
  const server = (push: ReturnType<typeof vi.fn>) => {
    const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-push-")));
    const { app } = buildServer({
      store,
      roadie: fakeRoadie(store),
      flipperPush: push,
    });
    return { app, store };
  };

  const pending = (store: AssetStore) => {
    const a = makeAsset(ID, "Purple Rain", "Prince");
    a.roadie.state = "awaiting_tag_write";
    store.save(a);
  };

  it("sends the pending CSV and reports what landed", async () => {
    const push = vi.fn().mockResolvedValue({
      port: "COM6",
      bytes: 48,
      path: FLIPPER_PENDING_PATH,
    });
    const { app, store } = server(push);
    pending(store);

    const res = await app.inject({
      method: "POST",
      url: "/api/tags/push-to-flipper",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, albums: 1, port: "COM6" });
    // What went over the wire is the same bytes the download route serves.
    expect(push).toHaveBeenCalledWith(
      `curatorId,name,artist\n${ID},Purple Rain,Prince\n`,
    );
  });

  /** No Flipper attached is a fact about the desk, not a server fault — 503, with the reason shown. */
  it("503s with the reason when there is no Flipper", async () => {
    const push = vi
      .fn()
      .mockRejectedValue(new FlipperPushError("No Flipper found on USB."));
    const { app, store } = server(push);
    pending(store);

    const res = await app.inject({
      method: "POST",
      url: "/api/tags/push-to-flipper",
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      ok: false,
      error: "No Flipper found on USB.",
      path: FLIPPER_PENDING_PATH,
    });
  });

  it("still pushes (a header-only file) when nothing is pending", async () => {
    const push = vi.fn().mockResolvedValue({
      port: "COM6",
      bytes: 22,
      path: FLIPPER_PENDING_PATH,
    });
    const { app } = server(push);

    const res = await app.inject({
      method: "POST",
      url: "/api/tags/push-to-flipper",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ albums: 0 });
    expect(push).toHaveBeenCalledWith("curatorId,name,artist\n");
  });
});

/**
 * The Ship tab's per-album add. Two properties distinguish it from the batch route: it is not
 * filtered by roadie state (you named this album), and it merges rather than replaces.
 */
describe("POST /api/albums/:curatorId/push-to-flipper", () => {
  const server = (append: ReturnType<typeof vi.fn>) => {
    const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-push1-")));
    const { app } = buildServer({
      store,
      roadie: fakeRoadie(store),
      flipperAppend: append,
    });
    return { app, store };
  };
  const ok = (total = 1) =>
    vi.fn().mockResolvedValue({
      port: "COM6",
      bytes: 50,
      path: FLIPPER_PENDING_PATH,
      total,
    });

  it("appends this album's row and reports the new list total", async () => {
    const append = ok(3);
    const { app, store } = server(append);
    store.save(makeAsset(ID, "Purple Rain", "Prince"));

    const res = await app.inject({
      method: "POST",
      url: `/api/albums/${ID}/push-to-flipper`,
    });

    expect(res.statusCode).toBe(200);
    // `total` is the count on the card after merging — not the number sent.
    expect(res.json()).toMatchObject({ ok: true, total: 3, port: "COM6" });
    expect(append).toHaveBeenCalledWith([
      { curatorId: ID, name: "Purple Rain", artist: "Prince" },
    ]);
  });

  /** The batch route only lists `awaiting_tag_write`; naming one album must not be filtered so. */
  it("works for an album that is not awaiting a tag write", async () => {
    const append = ok();
    const { app, store } = server(append);
    const a = makeAsset(ID, "Purple Rain", "Prince");
    a.roadie.state = "awaiting_preview";
    store.save(a);

    const res = await app.inject({
      method: "POST",
      url: `/api/albums/${ID}/push-to-flipper`,
    });

    expect(res.statusCode).toBe(200);
    expect(append).toHaveBeenCalledOnce();
  });

  it("404s an unknown album without touching the Flipper", async () => {
    const append = ok();
    const { app } = server(append);

    const res = await app.inject({
      method: "POST",
      url: "/api/albums/zzzzzzzz/push-to-flipper",
    });

    expect(res.statusCode).toBe(404);
    expect(append).not.toHaveBeenCalled();
  });

  it("503s with the reason when no Flipper is attached", async () => {
    const append = vi
      .fn()
      .mockRejectedValue(new FlipperPushError("No Flipper found on USB."));
    const { app, store } = server(append);
    store.save(makeAsset(ID, "Purple Rain", "Prince"));

    const res = await app.inject({
      method: "POST",
      url: `/api/albums/${ID}/push-to-flipper`,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      ok: false,
      error: "No Flipper found on USB.",
    });
  });
});

/**
 * One device, one port, and `appendToFlipper` is a read-modify-write — so two near-simultaneous
 * clicks (the Queue button and a Ship tab) must not interleave on the same file, or one album is
 * silently lost. Queuing is the fix; these pin it.
 */
describe("oneAtATime", () => {
  it("runs sessions in order, never overlapping", async () => {
    const events: string[] = [];
    const session = (name: string, ms: number) =>
      oneAtATime(async () => {
        events.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`${name}:end`);
        return name;
      });

    // The slow one is started first; if they overlapped, b:start would land before a:end.
    const [a, b] = await Promise.all([session("a", 30), session("b", 0)]);

    expect([a, b]).toEqual(["a", "b"]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("keeps running later sessions after one fails", async () => {
    const failed = oneAtATime(async () => {
      throw new FlipperPushError("no Flipper");
    });
    await expect(failed).rejects.toThrow(/no Flipper/);

    // A poisoned queue would leave every later push hanging or rejected.
    await expect(oneAtATime(async () => "ok")).resolves.toBe("ok");
  });

  it("gives each caller its own result", async () => {
    const results = await Promise.all([
      oneAtATime(async () => 1),
      oneAtATime(async () => 2),
      oneAtATime(async () => 3),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });
});
