// The production SonosDriver: drives Sonos over local UPnP via @svrooij/sonos, exactly as the proven
// spike (spikes/sonos-spotify/play-album.js) does. Cannot be unit-tested without hardware, so the
// logic is deliberately thin and everything else routes through the SonosDriver port (FakeSonosDriver
// covers the service logic). See ADR 0023 / amp-spec §10 for the why behind each step.
import { SonosManager, MetaDataHelper } from "@svrooij/sonos";
import type { SonosDevice } from "@svrooij/sonos";
import { SonosUnavailableError, type SonosDriver } from "./driver.js";
import { parseFavoriteBinding, type SpotifyBinding } from "./binding.js";

const DISCOVERY_TIMEOUT_MS = 12_000;
const OP_TIMEOUT_MS = 15_000;

/** Reject with a tolerated SonosUnavailableError if a Sonos call hangs — Amp is always-on. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(new SonosUnavailableError(`${label} timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

export class SvrooijSonosDriver implements SonosDriver {
  private manager: SonosManager | null = null;
  private binding: SpotifyBinding | null = null;

  /** `seedHost` (a speaker IP) uses topology-from-device; otherwise SSDP discovery. */
  constructor(private readonly seedHost?: string) {}

  async play(target: string, spotifyUri: string): Promise<void> {
    try {
      const coordinator = await this.resolveCoordinator(target);
      const binding = await this.deriveBinding(coordinator);
      const region = binding.token.match(/SA_RINCON(\d+)_/)?.[1] ?? "3079";

      // Let the library build the container URI + metadata (its serialization is UPnP-valid), then
      // patch in the household's real sid/sn. Hand-rolled metadata tripped UPnP 402 in the spike.
      const guessed = MetaDataHelper.GuessMetaDataAndTrackUri(
        spotifyUri,
        region,
      );
      const trackUri = guessed.trackUri
        .replace(/([?&])sid=\d+/, `$1sid=${binding.sid}`)
        .replace(/([?&])sn=\d+/, `$1sn=${binding.sn}`);

      await withTimeout(
        (async () => {
          await coordinator.AVTransportService.RemoveAllTracksFromQueue({
            InstanceID: 0,
          }).catch(() => {
            /* empty queue / unsupported — ignore, the add below still works */
          });
          await coordinator.AVTransportService.AddURIToQueue({
            InstanceID: 0,
            EnqueuedURI: trackUri,
            EnqueuedURIMetaData: guessed.metadata,
            DesiredFirstTrackNumberEnqueued: 0,
            EnqueueAsNext: true,
          });
          await coordinator.SwitchToQueue();
          await coordinator.Play();
        })(),
        OP_TIMEOUT_MS,
        "Sonos play",
      );
    } catch (err) {
      // A play failure may mean stale topology/binding — reset so the next scan rediscovers.
      this.reset();
      throw err instanceof SonosUnavailableError
        ? err
        : new SonosUnavailableError(
            `Sonos play failed: ${(err as Error).message}`,
          );
    }
  }

  async stop(target: string): Promise<void> {
    try {
      const coordinator = await this.resolveCoordinator(target);
      await withTimeout(coordinator.Stop(), OP_TIMEOUT_MS, "Sonos stop");
    } catch (err) {
      throw err instanceof SonosUnavailableError
        ? err
        : new SonosUnavailableError(
            `Sonos stop failed: ${(err as Error).message}`,
          );
    }
  }

  async rooms(): Promise<string[]> {
    const manager = await this.ensureManager();
    return manager.Devices.map((d) => d.Name);
  }

  private reset(): void {
    const mgr = this.manager;
    this.manager = null;
    this.binding = null;
    // Release the manager's zone-event subscriptions/SSDP sockets before dropping it, so repeated
    // Sonos failures over a long uptime don't accumulate abandoned managers (runtime review).
    try {
      mgr?.CancelSubscription();
    } catch {
      /* best-effort cleanup */
    }
  }

  private async ensureManager(): Promise<SonosManager> {
    if (this.manager && this.manager.Devices.length) return this.manager;
    const manager = new SonosManager();
    await withTimeout(
      this.seedHost
        ? manager.InitializeFromDevice(this.seedHost)
        : manager.InitializeWithDiscovery(10),
      DISCOVERY_TIMEOUT_MS,
      "Sonos discovery",
    );
    if (!manager.Devices.length)
      throw new SonosUnavailableError("no Sonos devices found on the LAN");
    this.manager = manager;
    return manager;
  }

  /**
   * Find the target room's group COORDINATOR — queue commands sent to a member fail with UPnP 800.
   * `.Coordinator` returns the group coordinator when discovery parsed the topology, else the device
   * itself (a standalone room is its own coordinator). Match the target by exact room name first, then
   * by a group name that contains it (a joined group is named e.g. "Kitchen + 1").
   */
  private async resolveCoordinator(target: string): Promise<SonosDevice> {
    const manager = await this.ensureManager();
    const t = target.toLowerCase();
    const device =
      manager.Devices.find((d) => d.Name.toLowerCase() === t) ??
      manager.Devices.find((d) =>
        (d.GroupName ?? "").toLowerCase().includes(t),
      );
    if (!device)
      throw new SonosUnavailableError(`no Sonos room named "${target}"`);
    return device.Coordinator ?? device;
  }

  /**
   * Derive the household's Spotify sid/sn/cdudn-token from an existing Sonos favorite (FV:2). Cached
   * — the account-level binding is reusable across albums. No favorite → we can't build a valid
   * container, so degrade (SonosUnavailableError).
   */
  private async deriveBinding(device: SonosDevice): Promise<SpotifyBinding> {
    if (this.binding) return this.binding;
    const res = await withTimeout(
      device.ContentDirectoryService.Browse({
        ObjectID: "FV:2",
        BrowseFlag: "BrowseDirectChildren",
        Filter: "*",
        StartingIndex: 0,
        RequestedCount: 200,
        SortCriteria: "",
      }),
      OP_TIMEOUT_MS,
      "Sonos favorites browse",
    );
    const binding = parseFavoriteBinding(String(res?.Result ?? ""));
    if (!binding)
      throw new SonosUnavailableError(
        "no Spotify favorite found — add one album to Sonos Favorites so Amp can derive the account binding",
      );
    this.binding = binding;
    return this.binding;
  }
}
