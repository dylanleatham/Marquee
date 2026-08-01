// One service's reachability, rendered the same way everywhere it appears — Settings' "Test
// connections" and the System status page. Shared rather than copied so the three-state distinction
// below can't drift apart between them.
import type { ServiceHealth } from "../api";

const SERVICE_LABEL: Record<ServiceHealth["service"], string> = {
  conductor: "Hue Conductor — lights",
  backdrop: "Backdrop — display",
  amp: "Amp — Sonos audio",
  stylus: "Stylus — the stand's reader",
};

export function HealthRow({ health }: { health: ServiceHealth }) {
  // Three distinct outcomes, not two: never set up, set up but unreachable, working.
  //
  // Each carries its own **word**, because colour is never the only channel (curator-ui-ux §3.4).
  // The tone previously collapsed `bad` into `off` when building the class name, so an unreachable
  // service was styled identically to an unconfigured one — the text still distinguished them, so
  // it was never an a11y failure, but a status page leans on exactly that distinction.
  const tone = !health.configured ? "off" : health.reachable ? "ok" : "bad";
  const word = !health.configured
    ? "Not configured"
    : health.reachable
      ? "Reachable"
      : "Unreachable";
  return (
    <li className={`legs__item legs__item--${tone}`}>
      <span aria-hidden="true" className="legs__dot" />
      <b>{SERVICE_LABEL[health.service]}</b> {word}
      {health.url && <code className="health__url">{health.url}</code>}
      {health.detail && <em> — {health.detail}</em>}
    </li>
  );
}

export function ServiceHealthList({ health }: { health: ServiceHealth[] }) {
  return (
    <ul className="legs">
      {health.map((h) => (
        <HealthRow key={h.service} health={h} />
      ))}
    </ul>
  );
}
