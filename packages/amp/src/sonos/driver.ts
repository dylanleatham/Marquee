// The Sonos hardware seam. Everything Sonos-specific lives behind this port, mirroring how
// hue-conductor hides the bridge behind HueDriver — so the engine + scan logic are testable with a
// fake, and the transport (in-process @svrooij/sonos vs an HTTP client to node-sonos-http-api) can
// change without touching the rest of Amp.

/**
 * A Sonos control surface scoped to what Amp needs: play a Spotify album on a target room/group, stop
 * it, and list rooms for the settings picker. Implementations resolve the group coordinator and the
 * account's Spotify binding internally (see the svrooij driver).
 */
export interface SonosDriver {
  /** Start `spotify:album:<id>` on the target room/group. Resolves once playback has been requested. */
  play(target: string, spotifyUri: string): Promise<void>;
  /** Stop playback on the target room/group. */
  stop(target: string): Promise<void>;
  /** Discoverable room/group names (for Curator's target picker). */
  rooms(): Promise<string[]>;
}

/**
 * The Sonos side couldn't do the job for an environmental reason we expect and tolerate: the target
 * room isn't on the network, no Spotify favorite exists to derive the account binding, or a SOAP call
 * failed. Callers degrade a scan to `202 { action: "ignored" }` on this — a hardware scan must not
 * error-storm the always-on service (runtime-overview §9). Genuine programming errors throw normally
 * and surface as 5xx.
 */
export class SonosUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SonosUnavailableError";
  }
}
