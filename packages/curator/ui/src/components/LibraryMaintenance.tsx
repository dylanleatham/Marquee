// Settings → Library: collection-wide maintenance (curator-spec §Palettes, issue #104).
//
// This is the "Palette Press changed, re-derive everything" path. It exists because the alternative
// is opening every album and pressing Reset to auto — ADR 0022 already changed pattern selection once
// and issue #105 will change the palette signals again, so a library-wide re-derive is a recurring
// need, not a hypothetical one.
//
// The run itself is reported by the app-wide progress panel, not here: it outlives this screen.
import { useState } from "react";
import { startPaletteRegen, useBatchJob } from "../batchJob";
import { useConfirm } from "./Confirm";
import { AsyncButton } from "./common";

export function LibraryMaintenance() {
  const [force, setForce] = useState(false);
  const { job } = useBatchJob();
  const confirm = useConfirm();
  const running = job?.status === "running";

  const run = async () => {
    // Forcing discards hand-edited palettes across the whole collection, and nothing else in Curator
    // does that. curator-spec §12: never overwrite a hand-edit without explicit user action — a
    // checkbox plus a button is two clicks, but neither of them names the consequence.
    if (
      force &&
      !(await confirm({
        title: "Discard every hand-edited palette?",
        body: "Forcing re-extracts all palettes from cover art, including the ones you edited by hand. Those edits can't be recovered.",
        confirmLabel: "Regenerate everything",
        destructive: true,
      }))
    )
      return;
    await startPaletteRegen(force);
  };

  return (
    <>
      <h2>Library</h2>
      <p className="muted">
        Re-derive every palette from its cover art — what you want after a
        Palette Press upgrade changes how colours or motion are chosen.
        Hand-edited palettes are left alone, along with albums Roadie is still
        processing and any without cover art. It runs in the background and can
        be stopped part-way; palettes already regenerated stay regenerated.
      </p>
      <label className="toggle">
        <input
          type="checkbox"
          checked={force}
          disabled={running}
          onChange={(e) => setForce(e.target.checked)}
        />
        Include hand-edited palettes (discards those edits)
      </label>
      <div className="row-actions">
        <AsyncButton
          className="btn"
          onClick={run}
          disabled={running}
          pendingLabel="Starting…"
        >
          {running ? "Regenerating…" : "Regenerate all palettes"}
        </AsyncButton>
      </div>
    </>
  );
}
