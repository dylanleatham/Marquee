// The default visualizer — the one clip Backdrop plays for every record that has none of its own
// ([ADR 0073](../../../../docs/adrs/0073-a-record-with-no-visualizer-plays-the-default.md)).
//
// ADR 0073 shipped the runtime half and left getting the file onto the Pi to `scp` plus a hand-run
// `ffmpeg`, which made the clip that plays *most often* the only one nobody encodes for the hardware.
// This module is the Curator half: the same ingest every visualizer goes through, aimed at a
// reserved fileId.
import { existsSync, rmSync, statSync } from "node:fs";
import type { Paths } from "../store/paths.js";
import type { CuratorSettings, DefaultVisualizerMeta } from "../settings.js";

/**
 * The reserved fileId the default clip is stored under, in Curator and on Backdrop alike.
 *
 * **It cannot collide with an album.** A curatorId is `^[a-z0-9]{8}$` and this is seven characters,
 * so no album can ever claim it and `isCuratorId` rejects it on every per-album route. Sharing the
 * `visualizers/` directory is deliberate rather than incidental: it means `ingestVideo` works
 * unaltered, the thumbnail lands where the preview already looks for it, and Curator's layout
 * matches the Pi's — Backdrop's `media_dir` *is* its visualizers directory, so the file has the same
 * name at both ends. Backdrop's upload route accepts this exact literal for the same reason.
 */
export const DEFAULT_VISUALIZER_FILE_ID = "default";

/** Where the default clip lives locally. */
export const defaultVisualizerFile = (paths: Paths): string =>
  paths.visualizerFile(DEFAULT_VISUALIZER_FILE_ID);

/** Its poster frame, rendered by the same ingest that renders every visualizer's. */
export const defaultVisualizerThumbnail = (paths: Paths): string =>
  paths.thumbnailFile(DEFAULT_VISUALIZER_FILE_ID);

/** What `GET /api/settings/default-visualizer` answers. */
export interface DefaultVisualizerStatus {
  /** The bytes are on **this** machine — i.e. there is something to preview and to push. */
  present: boolean;
  /** Size on disk, for the "is this a sensible clip" sniff test. `null` when absent. */
  bytes: number | null;
  /** What ingest recorded when it was accepted. `null` when nothing has ever been uploaded. */
  meta: DefaultVisualizerMeta | null;
}

/**
 * Describe the default clip from disk **and** settings, rather than trusting either alone.
 *
 * They can disagree in both directions and each disagreement means something different: metadata
 * with no file is a clip deleted out from under Curator (the UI must not offer to push it), and a
 * file with no metadata is one dropped in by hand (perfectly playable, so it is reported present —
 * it simply has no duration to show). Reading only `settings.json` would have made the first case
 * invisible, which is the same "listed but unplayable" gap ADR 0038 closed for albums.
 */
export function describeDefaultVisualizer(
  paths: Paths,
  settings: CuratorSettings,
): DefaultVisualizerStatus {
  const file = defaultVisualizerFile(paths);
  const present = existsSync(file);
  return {
    present,
    bytes: present ? statSync(file).size : null,
    meta: settings.defaultVisualizer ?? null,
  };
}

/** Remove the local clip and its thumbnail. Best-effort — a missing file is the desired end state. */
export function removeDefaultVisualizer(paths: Paths): void {
  rmSync(defaultVisualizerFile(paths), { force: true });
  rmSync(defaultVisualizerThumbnail(paths), { force: true });
}
