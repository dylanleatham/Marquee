// Offline preview generator for the streaming effects (ADR 0023). Runs the *real* renderers over a
// sample room + palette, precomputes a loop of frames for each effect, and writes a self-contained
// HTML page that replays them as glowing orbs at the lights' positions — so you can watch aurora /
// shimmer / wave without a Hue bridge. This is what makes the effect work verifiable by eye.
//
//   pnpm --filter @marquee/hue-conductor preview:stream [outfile.html]
//
// The page body is emitted without <html>/<head>/<body> so it can be published directly as an
// Artifact (which supplies that skeleton), and also stands alone in a browser.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { aurora, shimmer, wave } from "./renderers.js";
import type { StreamFrame, StreamLight, StreamRenderer } from "./types.js";

// A plausible listening-room layout: five around the front/sides, two behind. x∈[-1,1] L→R, y rear→front.
const LIGHTS: StreamLight[] = [
  { id: "front-left", x: -0.7, y: -0.9 },
  { id: "center", x: 0, y: -1 },
  { id: "front-right", x: 0.7, y: -0.9 },
  { id: "left", x: -1, y: 0.1 },
  { id: "right", x: 1, y: 0.1 },
  { id: "rear-left", x: -0.55, y: 0.95 },
  { id: "rear-right", x: 0.55, y: 0.95 },
];

// Purple Rain's palette (the step-1 fixture golden) — a recognizable, vivid reference.
const PALETTE = ["#7867A0", "#D5A370", "#D98D40", "#711E20"];

const FPS = 25;
const LOOP_SECONDS = 12;
const FRAME_COUNT = FPS * LOOP_SECONDS;

const EFFECTS: Array<{
  name: string;
  blurb: string;
  renderer: StreamRenderer;
}> = [
  {
    name: "aurora",
    blurb:
      "A slow flow-field drift — colors bleed and morph across the room, never quite repeating.",
    renderer: aurora(LIGHTS, PALETTE),
  },
  {
    name: "shimmer",
    blurb:
      "The palette held across the lights with a candlelight twinkle riding each one's brightness.",
    renderer: shimmer(LIGHTS, PALETTE),
  },
  {
    name: "wave",
    blurb:
      "A band of color physically sweeps across the actual light positions, left to right.",
    renderer: wave(LIGHTS, PALETTE, { angleDeg: 0 }),
  },
];

/**
 * Precompute one loop of frames, stripped to `[r,g,b]` per light. Light order matches `LIGHTS`, so
 * the ids are redundant per frame — dropping them keeps the embedded payload small.
 */
function precompute(renderer: StreamRenderer): number[][][] {
  const frames: number[][][] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const f: StreamFrame = renderer.frame((i * 1000) / FPS);
    frames.push(f.map((c) => [c.r, c.g, c.b]));
  }
  return frames;
}

const data = {
  lights: LIGHTS,
  fps: FPS,
  palette: PALETTE,
  effects: EFFECTS.map((e) => ({
    name: e.name,
    blurb: e.blurb,
    frames: precompute(e.renderer),
  })),
};

const html = `<title>Marquee — streaming light effects</title>
<style>
  /* Neutrals carry a faint purple bias, drawn from the Purple Rain palette the effects sample. */
  :root {
    --bg:#f5f4f7; --fg:#1a1922; --muted:#6d6a78; --card:#ffffff; --border:#e6e4ec;
    --accent:#7867a0; --stage-a:#141019; --stage-b:#050406;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d0c11; --fg:#ecebf2; --muted:#9793a4; --card:#17151d; --border:#272430; --accent:#b3a6dc; }
  }
  :root[data-theme="light"] { --bg:#f5f4f7; --fg:#1a1922; --muted:#6d6a78; --card:#ffffff; --border:#e6e4ec; --accent:#7867a0; }
  :root[data-theme="dark"]  { --bg:#0d0c11; --fg:#ecebf2; --muted:#9793a4; --card:#17151d; --border:#272430; --accent:#b3a6dc; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 34px 22px 60px; }
  .eyebrow { font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); font-weight:650; margin:0 0 8px; }
  h1 { font-size: clamp(24px, 4vw, 34px); line-height:1.1; letter-spacing:-0.02em; margin:0 0 10px; text-wrap:balance; }
  .sub { color: var(--muted); margin: 0 0 20px; max-width: 62ch; }
  .palette { display:flex; align-items:center; gap:9px; margin:0 0 28px; flex-wrap:wrap; }
  .palette .swatch { width:26px; height:26px; border-radius:7px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); }
  .palette .label { color:var(--muted); font-size:12.5px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 18px; }
  .card { background: var(--card); border:1px solid var(--border); border-radius: 16px; overflow: hidden; }
  .stage { display:block; width:100%; aspect-ratio: 1 / 1;
    background: radial-gradient(circle at 50% 42%, var(--stage-a), var(--stage-b)); }
  .meta { padding: 13px 15px 16px; }
  .name { font-weight: 650; text-transform: capitalize; margin: 0 0 3px; letter-spacing:-0.01em; }
  .blurb { color: var(--muted); font-size: 13px; margin: 0; }
  .foot { color: var(--muted); font-size: 12.5px; margin-top: 28px; max-width: 70ch; }
  code { background: var(--border); padding: 1px 6px; border-radius: 6px; font-size: 12px; }
</style>
<div class="wrap">
  <p class="eyebrow">Marquee · Hue Conductor</p>
  <h1>Streaming light effects</h1>
  <p class="sub">Beyond a static palette or a slow crossfade: the <strong>aurora</strong>, <strong>shimmer</strong>, and <strong>wave</strong> renderers, driven by the real streaming engine over a seven-light room. Each orb is a bulb at its actual position — watch the wave sweep <em>across</em> the layout.</p>
  <div class="palette" id="palette"><span class="label">Palette — Purple Rain</span></div>
  <div class="grid" id="grid"></div>
  <p class="foot">Frames precomputed at ${FPS}fps by <code>pnpm preview:stream</code> — exactly what the engine emits. The transport that pushes these to the bridge over DTLS is the hardware follow-up (ADR 0023).</p>
</div>
<script>
const DATA = ${JSON.stringify(data)};
const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const pal = document.getElementById("palette");
for (const hex of DATA.palette) {
  const s = document.createElement("span");
  s.className = "swatch"; s.style.background = hex; s.title = hex;
  pal.insertBefore(s, pal.firstChild);
}

function setup(card, effect) {
  const canvas = card.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  function size() {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  }
  size(); window.addEventListener("resize", () => { size(); if (reduce) render(0); });
  // Map light x,y in [-1,1] into the stage with a margin so glows aren't clipped.
  const pos = (v) => 0.13 + ((v + 1) / 2) * 0.74;
  function render(idx) {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const frame = effect.frames[idx];
    const radius = Math.min(W, H) * 0.2;
    for (let i = 0; i < DATA.lights.length; i++) {
      const l = DATA.lights[i], c = frame[i], col = c[0] + "," + c[1] + "," + c[2];
      const cx = pos(l.x) * W, cy = pos(l.y) * H;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      g.addColorStop(0, "rgba(" + col + ",0.95)");
      g.addColorStop(0.5, "rgba(" + col + ",0.32)");
      g.addColorStop(1, "rgba(" + col + ",0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgb(" + col + ")";
      ctx.beginPath(); ctx.arc(cx, cy, radius * 0.12, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (reduce) { render(0); return; } // respect reduced-motion: show a representative still
  const start = performance.now();
  function loop(now) {
    render(Math.floor(((now - start) / 1000) * DATA.fps) % effect.frames.length);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

const grid = document.getElementById("grid");
for (const effect of DATA.effects) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = '<canvas class="stage"></canvas><div class="meta"><p class="name">' +
    effect.name + '</p><p class="blurb">' + effect.blurb + '</p></div>';
  grid.appendChild(card);
  setup(card, effect);
}
</script>`;

const out = resolve(process.argv[2] ?? "stream-effects-preview.html");
writeFileSync(out, html);
console.log(`Wrote streaming-effects preview → ${out}`);
