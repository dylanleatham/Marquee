// Why a `fetch` rejected, in words that name the failure instead of guessing a cause (issue #270).
//
// Curator talks to four services over HTTP, and every "it's down" line the operator reads used to be
// the transport's own message pasted into a sentence that asserted more than the code knew. The
// worst of them said `not reachable at <url> — is it running?` for what was, on 2026-08-08, a
// healthy service behind a wifi link dropping 12% of packets. The service was running. Asking
// whether it was running is what cost the afternoon.
//
// The rule here: **say what happened, name the address it happened against, and stop.** A timeout
// means nothing answered in the budget — nothing more. Distinguishing it from a refusal is the whole
// value, because the two point at different halves of the system: an address nobody holds drops
// packets and burns the full budget, while a service that is genuinely down on an address that *is*
// held refuses the connection instantly. That signal already exists in `err.cause.code`; it was
// being thrown away.

/** The `code` undici hangs off `cause` when the failure came from the OS rather than from HTTP. */
const causeCode = (err: unknown): string | undefined => {
  const cause = (err as { cause?: unknown })?.cause;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
};

const errName = (err: unknown): string | undefined => {
  const name = (err as { name?: unknown })?.name;
  return typeof name === "string" ? name : undefined;
};

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * A one-line description of a failed `fetch`, suitable for a status page, a 502 body, or a job's
 * `error`.
 *
 * `timeoutMs` is the cap the call was actually given, so a timeout can say what it waited for rather
 * than leaving the reader to guess whether it gave up after a moment or a minute.
 *
 * Deliberately returns a phrase, not a sentence: the caller knows which service it was talking to
 * and prefixes accordingly, so the service name never appears twice (the System page already renders
 * it in its own column).
 */
export function describeFetchFailure(
  err: unknown,
  url: string,
  timeoutMs?: number,
  opts: {
    /**
     * Append the underlying code (`ECONNREFUSED`, `TimeoutError`) in parentheses.
     *
     * Off by default: curator-ui-ux §8.5 says an error is a sentence everywhere in the app *except*
     * the System page's stop control, which keeps the raw code precisely because paraphrasing takes
     * away the string you paste into a search. This flag is how that one surface keeps both — the
     * sentence that says what happened, and the token that is searchable.
     */
    includeCode?: boolean;
  } = {},
): string {
  const described = describe(err, url, timeoutMs);
  if (!opts.includeCode) return described;
  const code = causeCode(err) ?? errName(err);
  return code ? `${described} (${code})` : described;
}

function describe(err: unknown, url: string, timeoutMs?: number): string {
  const name = errName(err);

  // `AbortSignal.timeout` rejects with this; a caller-driven `AbortController` rejects with
  // AbortError. Same shape, opposite meanings — one is a fault, the other is someone pressing stop.
  if (name === "TimeoutError")
    return timeoutMs === undefined
      ? `no response from ${url}`
      : `no response from ${url} within ${timeoutMs}ms`;
  if (name === "AbortError") return "cancelled";

  switch (causeCode(err)) {
    case "ECONNREFUSED":
      return `${url} refused the connection — nothing is listening there`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `no route to ${url}`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `cannot resolve the host in ${url}`;
    case "ECONNRESET":
      return `the connection to ${url} was reset`;
    case "ETIMEDOUT":
      // The OS gave up on the handshake before our own budget ran out.
      return `no response from ${url} — the connection attempt timed out`;
    default:
      // Unknown failures keep their original text rather than being flattened into a guess; the url
      // is appended because that is the piece the operator needs and the raw message rarely carries.
      return `${errMessage(err)} (${url})`;
  }
}
