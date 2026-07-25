// Artwork override (issue #100 / curator-spec milestone 15). Lives in the **Look** workstation,
// because the cover is where the palette comes from — replacing a bad Spotify scan is a colour
// decision before it is a metadata one.
import { useRef } from "react";
import { api, artworkUrl, type AlbumAsset } from "../api";
import { AsyncButton } from "./common";
import { useConfirm } from "./Confirm";
import type { Run } from "./workflow";

export function ArtworkSection({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
}) {
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const overrideActive = asset.artwork?.overrideActive === true;
  const handEdited = asset.palette?.handEdited === true;

  /**
   * curator-spec §12: a hand-edited palette is never discarded without user action. Ask *before*
   * uploading rather than failing the request and making them pick the file again — the server
   * defaults to keeping the edit if we say nothing, so a dismissed dialog is still safe.
   */
  const askAboutPalette = async (): Promise<boolean | undefined> => {
    if (!handEdited) return true;
    return await confirm({
      title: "You have a hand-edited palette.",
      body: "Regenerate it from the new cover? Choosing Keep leaves your edited colours exactly as they are — you can always re-extract later from the palette editor.",
      confirmLabel: "Regenerate from new art",
      cancelLabel: "Keep my palette",
    });
  };

  const onFile = async (file: File) => {
    const regenerate = await askAboutPalette();
    await run(() => api.uploadArtworkOverride(curatorId, file, regenerate));
  };

  const remove = () =>
    run(async () => {
      const ok = await confirm({
        title: "Remove your uploaded cover?",
        body: "The album goes back to the cover fetched from Spotify or Discogs, and the palette is re-derived from it.",
        confirmLabel: "Remove override",
        destructive: true,
      });
      if (!ok) return;
      await api.removeArtworkOverride(curatorId);
    });

  return (
    <div className="artwork-section">
      <div className="artwork-section__main">
        {/* contentHash changes whenever the active cover does, so this both cache-busts and
            re-renders after an override lands. */}
        <img
          className="artwork-section__img"
          src={`${artworkUrl(curatorId)}?v=${encodeURIComponent(
            asset.artwork?.contentHash ?? "none",
          )}`}
          alt=""
        />
        <div className="artwork-section__body">
          <p className="muted">
            {overrideActive
              ? "Showing your uploaded cover. The palette, card art and video generation all derive from this image."
              : asset.artwork
                ? "Showing the fetched cover. Upload your own if this scan doesn't do the record justice."
                : "No cover yet."}
          </p>
          {overrideActive && <span className="tag">override active</span>}
          <div className="row-actions">
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg"
              className="visually-hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ""; // let the same file be picked twice in a row
                if (f) void onFile(f);
              }}
            />
            <button className="btn" onClick={() => input.current?.click()}>
              {overrideActive ? "Replace my cover" : "Upload my own cover"}
            </button>
            {overrideActive && (
              <AsyncButton
                className="btn btn--ghost"
                onClick={remove}
                pendingLabel="Removing…"
              >
                Revert to fetched cover
              </AsyncButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
