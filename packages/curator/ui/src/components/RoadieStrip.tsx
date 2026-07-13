import { api } from "../api";
import { STATE_LABEL } from "../format";
import { usePoll } from "../hooks";
import { Spinner } from "./common";

/** Persistent bottom strip: what Roadie is doing right now + pause/resume (curator-spec §10). */
export function RoadieStrip() {
  const { data: status, refresh } = usePoll(api.status, 2000);

  const toggle = async () => {
    if (!status) return;
    await (status.paused ? api.resume() : api.pause());
    refresh();
  };

  const summary = !status ? (
    <>
      <Spinner /> connecting to Roadie…
    </>
  ) : status.paused ? (
    "Roadie: paused"
  ) : status.current ? (
    <>
      Roadie: working on <code>{status.current}</code>
      {status.activity[0] ? ` (${STATE_LABEL[status.activity[0].to]})` : ""}
    </>
  ) : status.queueDepth > 0 ? (
    `Roadie: ${status.queueDepth} queued`
  ) : (
    "Roadie: idle, queue empty"
  );

  return (
    <footer className="roadie-strip">
      <span className="roadie-strip__summary">{summary}</span>
      {status && (
        <button className="btn btn--ghost btn--sm" onClick={toggle}>
          {status.paused ? "Resume" : "Pause"}
        </button>
      )}
    </footer>
  );
}
