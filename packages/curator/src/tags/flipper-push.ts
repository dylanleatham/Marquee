// Push the pending-tag list straight onto a USB-connected Flipper Zero (issue #68). Curator runs on
// the same workstation you plug the Flipper into (runtime-overview §"config vs. runtime"), so the
// list can go on the SD card with one click instead of a download-then-drag round trip.
//
// This talks the Flipper's plain-text serial **CLI**, not the protobuf RPC layer: `storage
// write_chunk <path> <size>` answers `Ready`, then takes exactly <size> raw bytes. Verified against
// firmware 1.4.3. The protocol lives behind `FlipperCli` so it is unit-testable with a fake; only
// `openSerialCli` touches real hardware.
//
// `serialport` is imported **lazily**, inside the two functions that need it. It carries a native
// binding, and a native binding that fails to load — wrong ABI, missing from a packaged build — must
// degrade to "the push button doesn't work" and never to "Curator won't start". Nothing else in this
// module needs it, so a top-level import would put the whole service behind it.
import {
  mergePendingCsv,
  parsePendingCsv,
  type PendingRow,
} from "./pending-csv.js";

type SerialPortModule = typeof import("serialport");

let serialportModule: SerialPortModule | undefined;

async function loadSerialport(): Promise<SerialPortModule> {
  if (!serialportModule) {
    try {
      serialportModule = await import("serialport");
    } catch (err) {
      throw new FlipperPushError(
        `Serial support is unavailable in this build: ${(err as Error).message}`,
      );
    }
  }
  return serialportModule;
}

/** Where the FAP looks for its list — `APP_DATA_PATH("pending.csv")` for appid marquee_tag_writer. */
export const FLIPPER_PENDING_PATH =
  "/ext/apps_data/marquee_tag_writer/pending.csv";

/** The Flipper's USB CDC identity. COM ports for Bluetooth etc. must never be opened by accident. */
const FLIPPER_VENDOR_ID = "0483";
const FLIPPER_PRODUCT_ID = "5740";
const FLIPPER_SERIAL_PREFIX = "FLIP_";

/** The CLI prompt, and the go-ahead `write_chunk` prints before it reads the payload. */
const PROMPT = ">: ";
const READY = "Ready";

/** Every read is bounded — a wedged serial port must not stall an always-on service. */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Bound a serial operation. **Every** call into `serialport` goes through this: open, write, and
 * drain each take a callback that a wedged or half-enumerated device can simply never invoke, and one
 * unbounded call is enough to hang a push request forever on an always-on service. Reads carry their
 * own deadline because they also need to report what arrived before giving up.
 */
function withTimeout<T>(
  what: string,
  timeoutMs: number,
  run: (resolve: (v: T) => void, reject: (e: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new FlipperPushError(`${what} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const done =
      <A extends unknown[]>(f: (...a: A) => void) =>
      (...a: A) => {
        clearTimeout(timer);
        f(...a);
      };
    try {
      run(done(resolve), done(reject));
    } catch (err) {
      // A synchronous throw (the SerialPort constructor rejecting a bad path, say) never reaches the
      // callbacks, so the timer would sit armed for the full deadline before firing into nothing.
      clearTimeout(timer);
      reject(err as Error);
    }
  });
}

/** The subset of `serialport`'s PortInfo we match on. */
export type FlipperPortInfo = {
  path: string;
  vendorId?: string | undefined;
  productId?: string | undefined;
  serialNumber?: string | undefined;
};

/**
 * Pick the Flipper out of the machine's serial ports. Matches on the USB VID/PID, or on the
 * `FLIP_<name>` serial number some platforms report instead — and on nothing else, so a Bluetooth
 * COM port is never opened and written to.
 */
export function findFlipperPort(
  ports: readonly FlipperPortInfo[],
): string | null {
  const match = ports.find((p) => {
    const vid = p.vendorId?.toLowerCase().replace(/^0x/, "");
    const pid = p.productId?.toLowerCase().replace(/^0x/, "");
    if (vid === FLIPPER_VENDOR_ID && pid === FLIPPER_PRODUCT_ID) return true;
    return (p.serialNumber ?? "")
      .toUpperCase()
      .startsWith(FLIPPER_SERIAL_PREFIX);
  });
  return match?.path ?? null;
}

/** Minimal serial-CLI surface. Implemented for real by `openSerialCli`, faked in tests. */
export interface FlipperCli {
  write(data: Buffer): Promise<void>;
  /** Read until `marker` appears; rejects on timeout, quoting what did arrive. */
  readUntil(marker: string, timeoutMs?: number): Promise<string>;
  /**
   * Read exactly `n` characters, however they are framed.
   *
   * File contents are read this way rather than "until the next prompt": the bytes on the card can
   * contain anything, including `>: `, and a marker search would stop inside the payload and return
   * a truncated list. The device tells us the length; that is the only trustworthy framing. (Content
   * is sanitised to ASCII by `pendingCsv`, so characters and bytes line up here.)
   */
  readCount(n: number, timeoutMs?: number): Promise<string>;
  /**
   * Discard anything already buffered, so the next `readUntil` can only match output caused by the
   * command we are about to send.
   *
   * This is load-bearing, not hygiene. A bare newline makes the Flipper print **two** prompts; with
   * one left in the buffer, `readUntil(PROMPT)` matches the stale one instantly and returns before
   * the real reply arrives. That silently made `readFile` answer `""`, which turned an append into a
   * replace and dropped the list already on the card.
   */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class FlipperPushError extends Error {}

const dirOf = (path: string): string =>
  path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * Send one CLI command and consume its echo, so every read after this is positioned at the command's
 * own output.
 *
 * Syncing on the echo rather than on a prompt is what makes this reliable. The device prints a
 * connect banner that ends in a prompt, and a bare newline yields *two* prompts — so "read until the
 * next prompt" can return someone else's output that merely arrived first. Cost of getting this
 * wrong: `readFile` answered `""`, so an append silently became a replace and dropped the list
 * already on the card. The echo of this exact command can only appear after we sent it.
 */
async function send(
  cli: FlipperCli,
  line: string,
  timeoutMs: number,
): Promise<void> {
  await cli.write(Buffer.from(`${line}\r\n`));
  // Include the echo's own line break, so the next read starts at the reply's first line rather
  // than at the leftover terminator.
  await cli.readUntil(`${line}\r\n`, timeoutMs);
}

/**
 * Write `contents` to `remotePath` on the Flipper and verify the size the device reports back.
 *
 * `storage mkdir` and `storage remove` failing are ignored on purpose: the directory usually already
 * exists and the file usually does not, and the CLI reports both as errors rather than no-ops. A
 * genuinely unwritable path fails at `write_chunk`, which is where we do care.
 *
 * The remove is not tidiness — **`write_chunk` appends to an existing file**. Verified on firmware
 * 1.4.3: pushing 84 bytes over a 105-byte file left 189 bytes, which the FAP would have read as a
 * doubled list. Deleting first is what makes the push idempotent.
 */
export async function pushFile(
  cli: FlipperCli,
  remotePath: string,
  contents: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ bytes: number }> {
  const payload = Buffer.from(contents, "utf8");

  await send(cli, `storage mkdir ${dirOf(remotePath)}`, timeoutMs);
  await cli.readUntil(PROMPT, timeoutMs);

  await send(cli, `storage remove ${remotePath}`, timeoutMs);
  await cli.readUntil(PROMPT, timeoutMs);

  await send(
    cli,
    `storage write_chunk ${remotePath} ${payload.length}`,
    timeoutMs,
  );
  const ready = await cli.readUntil(READY, timeoutMs);
  if (!ready.includes(READY))
    throw new FlipperPushError(`Flipper did not accept the write: ${ready}`);

  await cli.write(payload);
  await cli.readUntil(PROMPT, timeoutMs);

  // Verify rather than trust: `storage read` reports `Size: <n>` for what actually landed.
  await send(cli, `storage read ${remotePath}`, timeoutMs);
  const readBack = await cli.readUntil(PROMPT, timeoutMs);
  const size = /Size:\s*(\d+)/.exec(readBack);
  if (!size)
    throw new FlipperPushError(
      `Wrote the file but could not read it back: ${readBack}`,
    );
  if (Number(size[1]) !== payload.length)
    throw new FlipperPushError(
      `Wrote ${payload.length} bytes but the Flipper reports ${size[1]}`,
    );

  return { bytes: payload.length };
}

/**
 * Read a file back off the Flipper, or `""` when it isn't there yet.
 *
 * `storage read` answers `Size: <n>` then a blank line then the bytes, so we slice exactly `n` — the
 * content can contain anything, including something that looks like the prompt, and counting bytes
 * is the only framing the device actually guarantees. A missing file prints a storage error with no
 * `Size:` line, which is not a failure here: nothing on the card means nothing to merge with.
 */
export async function readFile(
  cli: FlipperCli,
  remotePath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  await send(cli, `storage read ${remotePath}`, timeoutMs);

  // The reply is either `Size: <n>\r\n` + a blank line + exactly n bytes, or a storage error.
  const line = await cli.readUntil("\r\n", timeoutMs);
  const size = /Size:\s*(\d+)/.exec(line);
  if (!size) return "";
  await cli.readCount(1, timeoutMs); // the blank line between header and body
  return cli.readCount(Number(size[1]), timeoutMs);
}

/** Open the Flipper's CLI over USB serial. Baud is ignored by the CDC device but must be supplied. */
export async function openSerialCli(
  path: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FlipperCli> {
  const { SerialPort } = await loadSerialport();
  const port = await withTimeout<InstanceType<typeof SerialPort>>(
    `Opening ${path}`,
    timeoutMs,
    (resolve, reject) => {
      const p = new SerialPort({ path, baudRate: 115200 }, (err) =>
        err ? reject(err) : resolve(p),
      );
    },
  );

  let buffer = "";
  port.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
  });

  return {
    // Both halves are bounded: `write` queues, `drain` waits for the bytes to actually leave, and a
    // stalled device can hold either callback open indefinitely.
    write: (data) =>
      withTimeout<void>(
        "Writing to the Flipper",
        DEFAULT_TIMEOUT_MS,
        (resolve, reject) =>
          port.write(data, (err) =>
            err ? reject(err) : port.drain((e) => (e ? reject(e) : resolve())),
          ),
      ),

    readUntil: (marker, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      new Promise<string>((resolve, reject) => {
        const started = Date.now();
        const tick = setInterval(() => {
          const at = buffer.indexOf(marker);
          if (at !== -1) {
            clearInterval(tick);
            const seen = buffer.slice(0, at + marker.length);
            buffer = buffer.slice(at + marker.length);
            resolve(seen);
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(tick);
            const seen = buffer;
            buffer = "";
            reject(
              new FlipperPushError(
                `Timed out waiting for ${JSON.stringify(marker)} from the Flipper` +
                  (seen ? `; got ${JSON.stringify(seen.slice(-120))}` : ""),
              ),
            );
          }
        }, 20);
      }),

    readCount: (n, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      new Promise<string>((resolve, reject) => {
        const started = Date.now();
        const tick = setInterval(() => {
          if (buffer.length >= n) {
            clearInterval(tick);
            const seen = buffer.slice(0, n);
            buffer = buffer.slice(n);
            resolve(seen);
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(tick);
            reject(
              new FlipperPushError(
                `Timed out reading ${n} bytes from the Flipper (got ${buffer.length})`,
              ),
            );
          }
        }, 20);
      }),

    flush: async () => {
      buffer = "";
    },

    // Also bounded, and it resolves rather than rejects: close runs in a `finally`, so a port that
    // will not shut cleanly must not replace the real error (or the success) with its own.
    close: () =>
      withTimeout<void>("Closing the port", DEFAULT_TIMEOUT_MS, (resolve) =>
        port.close(() => resolve()),
      ).catch(() => undefined),
  };
}

/** How the route gets at the hardware; swapped for a fake in tests. */
export type FlipperPusher = (
  contents: string,
) => Promise<{ port: string; bytes: number; path: string }>;

/**
 * Add rows to the list already on the Flipper instead of replacing it, so tagging records one at a
 * time from each album's Ship tab builds the on-device menu up. Returns the merged total as well as
 * what was written, because "the Flipper now lists 4 albums" is the useful confirmation.
 *
 * Read and write share one CLI session: opening the port twice doubles the failure surface for no
 * gain, and the merge must not race a second press.
 */
export type FlipperAppender = (
  rows: readonly PendingRow[],
) => Promise<{ port: string; bytes: number; path: string; total: number }>;

/**
 * Find the attached Flipper and open its CLI. Shared by both entry points so the port matching, the
 * bounded listing, and the two failure messages a user can act on live in exactly one place.
 */
async function connect(): Promise<{ path: string; cli: FlipperCli }> {
  const { SerialPort } = await loadSerialport();
  // Bounded like every other call into serialport: enumeration touches the OS device tree and a
  // half-enumerated device can leave it pending.
  const ports = await withTimeout<FlipperPortInfo[]>(
    "Listing serial ports",
    DEFAULT_TIMEOUT_MS,
    (resolve, reject) => void SerialPort.list().then(resolve, reject),
  );

  const path = findFlipperPort(ports);
  if (!path)
    throw new FlipperPushError(
      "No Flipper found on USB. Plug it in, unlock it, and try again.",
    );

  try {
    return { path, cli: await openSerialCli(path) };
  } catch (err) {
    throw new FlipperPushError(
      `Could not open ${path}: ${(err as Error).message}. Close qFlipper or any serial console using it.`,
    );
  }
}

/**
 * One device session at a time, process-wide.
 *
 * There is a single Flipper on a single port, and `appendToFlipper` is a read-modify-write: two
 * near-simultaneous clicks (the Queue button and a Ship tab, say) would otherwise interleave on the
 * same file and one album would silently lose. Queuing is the whole fix — each caller still gets its
 * own result, just not concurrently. A failed session must not poison the queue, hence the catch.
 */
let deviceQueue: Promise<unknown> = Promise.resolve();

/** Exported for tests — the queue is the fix for the read-modify-write race, so it is pinned. */
export function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const next = deviceQueue.then(run, run);
  deviceQueue = next.catch(() => undefined);
  return next;
}

/**
 * Replace the list on the Flipper with `contents`. Throws `FlipperPushError` with a message meant to
 * be shown verbatim in the UI — "no Flipper found" and "the port is busy" are the two things that
 * actually happen, and both are the user's to fix.
 */
export const pushToFlipper: FlipperPusher = (contents) =>
  oneAtATime(async () => {
    const { path, cli } = await connect();
    try {
      const { bytes } = await pushFile(cli, FLIPPER_PENDING_PATH, contents);
      return { port: path, bytes, path: FLIPPER_PENDING_PATH };
    } finally {
      await cli.close();
    }
  });

/** `pushToFlipper`'s sibling that merges rather than replaces, in one read-modify-write session. */
export const appendToFlipper: FlipperAppender = (rows) =>
  oneAtATime(async () => {
    const { path, cli } = await connect();
    try {
      const existing = await readFile(cli, FLIPPER_PENDING_PATH);
      const merged = mergePendingCsv(existing, rows);
      const { bytes } = await pushFile(cli, FLIPPER_PENDING_PATH, merged);
      return {
        port: path,
        bytes,
        path: FLIPPER_PENDING_PATH,
        total: parsePendingCsv(merged).length,
      };
    } finally {
      await cli.close();
    }
  });
