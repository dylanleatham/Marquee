// Bounded, never-throwing reads of the runtime services, shared by `/api/settings/service-health`
// and `/api/system/status`.
//
// Extracted rather than copied: this is the fourth place in Curator that wanted "GET a service with
// the shared secret, give up after a few seconds, and turn any failure into data instead of an
// exception". The rule that matters is the last one — a status page whose own request 500s because
// one Pi is unplugged is worse than useless, since an unreachable service is the thing it exists to
// report.

/** How long any single probe waits. Matches the Conductor proxy and the Backdrop client. */
export const PROBE_TIMEOUT_MS = 5000;

/** One service's reachability, as the Settings screen and the status page both render it. */
export interface ServiceHealth {
  service: string;
  configured: boolean;
  reachable: boolean;
  url?: string;
  detail?: string;
}

export interface ProbeTarget {
  url?: string | undefined;
  sharedSecret?: string | undefined;
}

/**
 * GET `path` from a service and return its parsed JSON, or `null` for any failure at all —
 * unconfigured, unreachable, non-2xx, or unparseable. Callers pair it with a `ServiceHealth` when
 * they need to say *why*; when they just want the payload, absence is the whole answer.
 */
export async function getJson<T>(
  target: ProbeTarget | undefined,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T | null> {
  if (!target?.url) return null;
  try {
    const headers: Record<string, string> = {};
    if (target.sharedSecret) headers["x-trigger-secret"] = target.sharedSecret;
    const res = await fetchImpl(`${target.url}${path}`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Reachability for one service. `configured: false` (no URL) is deliberately distinct from
 * `reachable: false` (configured but not answering) — they call for different actions, and
 * collapsing them is a bug the Settings screen has already had once.
 */
export async function probeService(
  service: string,
  target: ProbeTarget | undefined,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceHealth> {
  if (!target?.url) return { service, configured: false, reachable: false };
  const { url } = target;
  try {
    const headers: Record<string, string> = {};
    if (target.sharedSecret) headers["x-trigger-secret"] = target.sharedSecret;
    const res = await fetchImpl(`${url}${path}`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return {
      service,
      configured: true,
      reachable: res.ok,
      url,
      ...(res.ok ? {} : { detail: `HTTP ${res.status}` }),
    };
  } catch (err) {
    return {
      service,
      configured: true,
      reachable: false,
      url,
      detail: (err as Error).message,
    };
  }
}
