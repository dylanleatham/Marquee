// Media upload (ADR 0038): Curator puts the visualizer file on Backdrop's host itself, over the
// same authed channel it already uses for the library projection. Before this, the file arrived by
// out-of-band rsync and `sync` reported success whether or not it ever did — five library entries,
// one file (issue #169).
//
// This is the first route that *writes* to Backdrop's disk from the network, so the properties that
// keep that safe — the fileId pattern, the size cap, and never leaving a truncated file behind —
// are tested directly rather than assumed.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buildServer } from "../src/server.js";
import { Library } from "../src/library.js";
import { FakeTimers, tempMedia, tempDataDir } from "./fakes.js";

const SECRET = "test-secret";
const AUTH = { "x-trigger-secret": SECRET };
const FILE_ID = "abc12345";

function build(over: Parameters<typeof buildServer>[0]["config"] = {}) {
  const { dir } = tempMedia([]);
  return {
    ...buildServer({
      config: { sharedSecret: SECRET, mediaDir: dir, ...over },
      library: new Library(tempDataDir()),
      timers: new FakeTimers(),
    }),
    mediaDir: dir,
  };
}

const put = (
  app: ReturnType<typeof build>["app"],
  fileId: string,
  payload: Buffer | string,
  headers: Record<string, string> = AUTH,
) =>
  app.inject({
    method: "PUT",
    url: `/api/media/${fileId}`,
    headers: { "content-type": "application/octet-stream", ...headers },
    payload,
  });

describe("PUT /api/media/:fileId", () => {
  it("writes the body to {mediaDir}/{fileId}.mp4 and reports the byte count", async () => {
    const { app, mediaDir } = build();
    const body = Buffer.from("fake mp4 bytes");

    const res = await put(app, FILE_ID, body);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ fileId: FILE_ID, bytes: body.length });
    const landed = join(mediaDir, `${FILE_ID}.mp4`);
    expect(existsSync(landed)).toBe(true);
    expect(readFileSync(landed)).toEqual(body);
  });

  it("is idempotent — the same fileId replaces, so a re-push is safe", async () => {
    const { app, mediaDir } = build();
    await put(app, FILE_ID, Buffer.from("first"));
    const res = await put(app, FILE_ID, Buffer.from("second version"));

    expect(res.statusCode).toBe(201);
    expect(readFileSync(join(mediaDir, `${FILE_ID}.mp4`), "utf8")).toBe(
      "second version",
    );
    // Replaced, not accumulated.
    expect(readdirSync(mediaDir).filter((f) => f.endsWith(".mp4"))).toEqual([
      `${FILE_ID}.mp4`,
    ]);
  });

  it("requires the shared secret like every other /api route", async () => {
    const { app, mediaDir } = build();
    const res = await put(app, FILE_ID, Buffer.from("x"), {});

    expect(res.statusCode).toBe(401);
    expect(existsSync(join(mediaDir, `${FILE_ID}.mp4`))).toBe(false);
  });

  /**
   * The fileId becomes a filename inside a directory Backdrop serves to a browser. Anything that
   * isn't the curatorId shape is rejected outright rather than sanitised — sanitising invites the
   * next bypass, and Curator has no reason to send anything else.
   */
  it.each([
    ["..%2f..%2fetc", "encoded traversal"],
    ["abc123", "too short"],
    ["abc123456", "too long"],
    ["ABC12345", "uppercase"],
    ["abc-1234", "punctuation"],
    ["abc 1234", "space"],
  ])("rejects %s (%s) with a 400 and writes nothing", async (fileId) => {
    const { app, mediaDir } = build();
    const res = await put(app, fileId, Buffer.from("payload"));

    expect(res.statusCode).toBe(400);
    expect(readdirSync(mediaDir)).toEqual([]);
  });

  /**
   * Raw `..` segments never reach the handler at all — the router normalises the path and finds no
   * route, so these are 404s rather than 400s. Asserting 400 here would be asserting a code path
   * that cannot run; what matters is that the request is refused and the disk is untouched.
   */
  it.each([
    ["..", "bare traversal"],
    ["../../etc/passwd", "traversal with separators"],
  ])("refuses %s (%s) before the handler, writing nothing", async (fileId) => {
    const { app, mediaDir } = build();
    const res = await put(app, fileId, Buffer.from("payload"));

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(readdirSync(mediaDir)).toEqual([]);
  });

  it("refuses a body larger than the cap, and leaves no partial file", async () => {
    const { app, mediaDir } = build({ maxUploadBytes: 16 });
    const res = await put(app, FILE_ID, Buffer.alloc(64, 1));

    expect(res.statusCode).toBe(413);
    expect(existsSync(join(mediaDir, `${FILE_ID}.mp4`))).toBe(false);
    // Not even the temp file survives — a leftover would fill the Pi's SD card over time.
    expect(readdirSync(mediaDir)).toEqual([]);
  });

  /**
   * The dangerous failure is not a failed upload — it is a *truncated* one that looks complete, which
   * Backdrop would hand to the kiosk as a valid video. The write goes to a temp file and is renamed
   * only once the stream ends cleanly, so the real filename never exists in a partial state.
   *
   * Asserting "the destination is absent after a failed upload" does NOT test that: an implementation
   * writing straight to the destination and deleting it on error passes too (verified by mutating the
   * source). What distinguishes them is an upload that fails over a file that already exists —
   * writing straight to the destination truncates the good video the moment the stream opens, so a
   * failed re-push destroys a working album.
   */
  it("leaves an existing video intact when a re-push fails", async () => {
    const { app, mediaDir } = build({ maxUploadBytes: 16 });
    const good = Buffer.from("the working video");
    // Seed it directly: it is larger than the cap, which is the point — it must survive a failure.
    writeFileSync(join(mediaDir, `${FILE_ID}.mp4`), good);

    const res = await put(app, FILE_ID, Buffer.alloc(64, 7));

    expect(res.statusCode).toBe(413);
    expect(readFileSync(join(mediaDir, `${FILE_ID}.mp4`))).toEqual(good);
    // And no temp file left behind next to it.
    expect(readdirSync(mediaDir)).toEqual([`${FILE_ID}.mp4`]);
  });

  it("leaves no destination file at all when a first upload fails", async () => {
    const { app, mediaDir } = build({ maxUploadBytes: 8 });
    await put(app, FILE_ID, Buffer.alloc(32, 7));

    expect(existsSync(join(mediaDir, `${FILE_ID}.mp4`))).toBe(false);
  });

  /**
   * Two uploads of the same album in flight at once — a re-push racing a retry, or two Curators.
   * The temp file must be unique per request: sharing one name lets the two streams interleave into
   * it, and the rename then publishes a file that is neither upload — a corrupt video that looks
   * complete, defeating the exact guarantee temp-then-rename exists to provide.
   *
   * Honest limitation: this is a guard, not a reproduction. `app.inject` delivers each body fast
   * enough that the two writes do not actually overlap, and reverting the fix to a shared temp name
   * leaves it passing (checked). Provoking a real interleave needs two genuinely slow socket streams.
   * The fix rests on inspection — one path, two concurrent writers — and this pins the outcome so a
   * future change that reintroduces blending is caught if it ever does overlap.
   */
  it("does not interleave concurrent uploads of the same fileId", async () => {
    const { app, mediaDir } = build();
    const a = Buffer.alloc(200_000, 0xaa);
    const b = Buffer.alloc(200_000, 0xbb);

    await Promise.all([put(app, FILE_ID, a), put(app, FILE_ID, b)]);

    const landed = readFileSync(join(mediaDir, `${FILE_ID}.mp4`));
    // Whichever won, the file must be exactly one of them — never a blend of both.
    const isA = landed.equals(a);
    const isB = landed.equals(b);
    expect(isA || isB).toBe(true);
    // And no temp files left over from the loser.
    expect(readdirSync(mediaDir)).toEqual([`${FILE_ID}.mp4`]);
  });

  /**
   * The read loop waits on the network. Without a bound, a client that drops off without closing its
   * socket parks it forever, holding a file descriptor and a temp file on the Pi's SD card — the
   * "unbounded loop over external state" the working agreement calls out. Bounded by inactivity
   * rather than a deadline, because a real visualizer over a poor link is legitimately slow.
   */
  it("abandons an upload whose bytes stop arriving, cleaning up after itself", async () => {
    const { app, mediaDir } = build({ uploadStallMs: 120 });
    // A body that sends one chunk and then never ends — a stalled client, not a slow one.
    const stalled = new Readable({ read() {} });
    stalled.push(Buffer.from("first chunk"));

    // The request settles one way or the other; what must not happen is hanging forever. A truly
    // dead connection cannot receive a reply, so the 408 is best-effort and the assertion here is
    // the durable property: the handler let go, and left nothing behind on the SD card.
    await app
      .inject({
        method: "PUT",
        url: `/api/media/${FILE_ID}`,
        headers: { ...AUTH, "content-type": "application/octet-stream" },
        payload: stalled,
      })
      .catch(() => undefined);

    expect(existsSync(join(mediaDir, `${FILE_ID}.mp4`))).toBe(false);
    expect(readdirSync(mediaDir)).toEqual([]); // no temp file left holding space
  });

  it("accepts an upload for an album that has no library entry yet", async () => {
    // File-then-metadata is the order Curator syncs in; the upload must not require the entry.
    const { app } = build();
    expect((await put(app, "zzzz9999", Buffer.from("x"))).statusCode).toBe(201);
  });
});
