// Guards on the deploy assets (issue #211, ADR 0047).
//
// These are shell/desktop files that nothing imports, so nothing would otherwise notice them
// regressing. They earn a test because both defects they encode were *invisible failures* that cost
// real evenings: a display-mode line silently missing drops 5.5% of frames, and a GPU flag silently
// re-added boots the kiosk to a black screen. Neither shows up in a build, a type-check, or any
// runtime assertion — the display just looks wrong across the room.
//
// The drift guard matters just as much. `kiosk.sh` used to exist only as a blob pasted out of
// DEPLOY.md, so the Pi and the runbook could disagree with nothing to catch it — which is exactly
// what happened for the whole life of #211. The file is now checked in and DEPLOY.md must point at
// it rather than carry a second copy that can rot.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkgDir = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(pkgDir, ...p), "utf8");

const kiosk = read("deploy", "kiosk.sh");
const autostart = read("deploy", "xcompmgr.desktop");
const deployDoc = read("DEPLOY.md");

/**
 * The flags ADR 0040 added on reasoning alone and reverted the same day: they override Chromium's
 * blocklist for the Pi's vc4/V3D driver, which takes the GPU process down so nothing ever paints.
 */
const BANNED_GPU_FLAGS = [
  "--ignore-gpu-blocklist",
  "--enable-gpu-rasterization",
  "--enable-zero-copy",
];

describe("kiosk launcher (deploy/kiosk.sh)", () => {
  it("forces the panel to 1920x1080 at 60Hz", () => {
    // Measured on the real stand: 5.5% of frames dropped sustained at 3840x2160@30 vs 0% at
    // 1920x1080@60, same file. A 4K mode makes Chromium rescale every frame, and a 30Hz mode gives a
    // 30fps clip exactly one scanout slot per frame — no slack for a late one.
    expect(kiosk).toMatch(/xrandr .*--mode 1920x1080 --rate 60/);
  });

  it("detects the connected output instead of hardcoding one", () => {
    // Which HDMI port is live differs per install, and `--output HDMI-1` on a board using HDMI-2
    // fails silently — leaving the panel at 4K with nothing to say so.
    expect(kiosk).toMatch(/xrandr \| awk/);
    expect(kiosk).toMatch(/--output "\$OUTPUT"/);
  });

  it("still launches the SPA as a file:// origin", () => {
    // A page served over http:// cannot load the local file:// clips (Chromium blocks cross-scheme),
    // so this is load-bearing, not a style choice — see DEPLOY.md step 11b.
    expect(kiosk).toContain(
      '--app="file:///home/pi/Marquee/packages/backdrop/public/index.html"',
    );
  });

  it("keeps muted autoplay working without a user gesture", () => {
    expect(kiosk).toContain("--autoplay-policy=no-user-gesture-required");
  });

  it.each(BANNED_GPU_FLAGS)("never carries %s", (flag) => {
    // Present only inside the warning comment, never on the chromium invocation.
    const code = kiosk
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toContain(flag);
  });
});

describe("compositor override (deploy/xcompmgr.desktop)", () => {
  it("actually suppresses the autostart entry", () => {
    // Both keys: `Hidden=true` is the XDG spec's mechanism, `X-GNOME-Autostart-enabled=false` is what
    // some session managers read instead. Only one of them being present is a coin flip.
    expect(autostart).toMatch(/^Hidden=true$/m);
    expect(autostart).toMatch(/^X-GNOME-Autostart-enabled=false$/m);
  });

  it("keeps the filename-matching fields that make it an override", () => {
    // The override works by *filename* against /etc/xdg/autostart/xcompmgr.desktop; the entry still
    // has to parse as the same application or a session manager may ignore it.
    expect(autostart).toMatch(/^Type=Application$/m);
    expect(autostart).toMatch(/^Name=xcompmgr$/m);
  });

  it("says how to put the compositor back", () => {
    // A disabled-by-default system service with no recorded way to re-enable it is a trap for
    // whoever finds it in a year.
    expect(autostart).toMatch(/RE-ENABLE|delete this file/i);
  });
});

describe("DEPLOY.md points at the deploy assets rather than duplicating them", () => {
  it("tells the operator to install both files from the repo", () => {
    expect(deployDoc).toContain("deploy/kiosk.sh");
    expect(deployDoc).toContain("deploy/xcompmgr.desktop");
  });

  it("carries no second copy of the chromium invocation", () => {
    // The inline copy is the drift: it is what the operator actually pastes, so when it and the real
    // launcher disagree the runbook wins on the hardware and loses in the repo.
    //
    // Matched on the launcher's opening line rather than on `--kiosk`, because the pasted block wraps
    // with backslashes and the flags land on later lines — a per-line "chromium AND --kiosk" check
    // passes against a full inline copy, which is how the first version of this test fooled itself.
    expect(deployDoc).not.toContain("chromium --password-store=basic");
  });
});
