// Guards on the manifest of files that live outside the checkout.
//
// The whole point of the manifest is that these files drift silently — a repo-side edit that never
// reaches the Pi looks exactly like a repo-side edit that did. So the tests here are mostly about
// the manifest telling the truth: every source exists, every destination is the one the docs name,
// and the templating leaves a stock install byte-identical to what a human would `cp`.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSETS,
  CANONICAL_HOME,
  CANONICAL_REPO,
  assetsFor,
  destFor,
  hostTakesAssets,
  render,
} from "../src/assets.js";
import { parseConfig, type Host } from "../src/hosts.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const [pi5, pizero, workstation] = parseConfig({
  hosts: {
    pi5: {
      ssh: "pi@backdrop.local",
      repo: "/home/pi/Marquee",
      kiosk: true,
      services: {
        conductor: { unit: "marquee-conductor", port: 4737 },
        backdrop: { unit: "backdrop", port: 4740 },
        amp: { unit: "marquee-amp", port: 4741 },
      },
    },
    pizero: {
      ssh: "pi@marquee-pizero.local",
      repo: "/home/pi/Marquee",
      services: { stylus: { unit: "marquee-stylus", port: 4741 } },
    },
    workstation: {
      repo: "C:/dev/Marquee",
      user: "dylan",
      services: { curator: { port: 4739 } },
    },
  },
}) as [Host, Host, Host];

describe("every asset the manifest claims", () => {
  it.each(ASSETS.map((a) => [a.id, a.source] as const))(
    "%s exists at %s",
    (_id, source) => {
      // A manifest entry pointing at a path that was moved or renamed fails at deploy time, on a Pi,
      // halfway through. Here it fails in CI, for free.
      expect(existsSync(join(repoRoot, source))).toBe(true);
    },
  );

  it("gives the kiosk launcher the execute bit and everything else 644", () => {
    // A 644 kiosk.sh fails at boot with an *empty* /tmp/kiosk.log — the script never runs far enough
    // to open its own log, so the one diagnostic the launcher provides is missing too.
    const byId = Object.fromEntries(ASSETS.map((a) => [a.id, a.mode]));
    expect(byId["kiosk-launcher"]).toBe("755");
    expect(
      ASSETS.filter((a) => a.id !== "kiosk-launcher").every(
        (a) => a.mode === "644",
      ),
    ).toBe(true);
  });

  it("gives every unit asset a service, and every user asset a home path", () => {
    for (const asset of ASSETS) {
      if (asset.kind === "unit") expect(asset.service).toBeDefined();
      else expect(asset.homePath).toBeDefined();
    }
  });
});

describe("which host takes which asset", () => {
  it("gives the Pi 5 its three units plus the kiosk assets", () => {
    expect(
      assetsFor(pi5)
        .map((a) => a.id)
        .sort(),
    ).toEqual([
      "amp-unit",
      "backdrop-unit",
      "compositor-override",
      "conductor-unit",
      "kiosk-autostart",
      "kiosk-launcher",
    ]);
  });

  it("gives the Pi Zero only the Stylus unit — it drives no display", () => {
    expect(assetsFor(pizero).map((a) => a.id)).toEqual(["stylus-unit"]);
  });

  it("gives the workstation nothing", () => {
    // Curator has no unit and no kiosk, and the install path pipes to `sudo tee` over SSH — which a
    // local Windows host has neither of.
    expect(assetsFor(workstation)).toEqual([]);
    expect(hostTakesAssets(workstation)).toBe(false);
    expect(hostTakesAssets(pi5)).toBe(true);
  });
});

describe("destinations", () => {
  it("names a unit file after the unit that host actually runs, not after the repo file", () => {
    // The Backdrop split, which is the reason units are configuration at all: this host installed
    // `backdrop`, so the repo's marquee-backdrop.service must land as backdrop.service. Writing it
    // under the repo's name would leave two units fighting over port 4740.
    const backdrop = ASSETS.find((a) => a.id === "backdrop-unit")!;
    expect(destFor(backdrop, pi5)).toBe("/etc/systemd/system/backdrop.service");
  });

  it("puts user assets under the owning account's home", () => {
    const kiosk = ASSETS.find((a) => a.id === "kiosk-launcher")!;
    const autostart = ASSETS.find((a) => a.id === "kiosk-autostart")!;
    expect(destFor(kiosk, pi5)).toBe("/home/pi/kiosk.sh");
    expect(destFor(autostart, pi5)).toBe(
      "/home/pi/.config/autostart/backdrop-kiosk.desktop",
    );
  });

  it("refuses to place a unit on a host that doesn't run that service", () => {
    const amp = ASSETS.find((a) => a.id === "amp-unit")!;
    expect(() => destFor(amp, pizero)).toThrow(/does not run/);
  });
});

describe("rendering for a host", () => {
  it("leaves a stock install byte-identical to the file in the repo", () => {
    // This is what keeps the documented `cp ~/Marquee/packages/backdrop/deploy/kiosk.sh ~/kiosk.sh`
    // honest for anyone installing by hand: on the standard layout the deployer writes exactly the
    // bytes that are checked in, so a `diff` between them is silence.
    for (const asset of assetsFor(pi5)) {
      const source = readFileSync(join(repoRoot, asset.source), "utf8");
      expect(render(source, pi5)).toBe(source);
    }
  });

  it("rewrites the repo path before the home path", () => {
    // Home is a prefix of repo, so replacing the shorter one first turns /home/pi/Marquee into
    // <home>/Marquee and silently ignores a configured repo location.
    const host: Host = {
      ...pi5,
      repo: "/srv/marquee",
      home: "/var/lib/marquee",
      user: "mq",
    };
    expect(render(`${CANONICAL_REPO}/packages/amp/dist/server.js`, host)).toBe(
      "/srv/marquee/packages/amp/dist/server.js",
    );
    expect(render(`${CANONICAL_HOME}/kiosk.sh`, host)).toBe(
      "/var/lib/marquee/kiosk.sh",
    );
  });

  it("rewrites every canonical path in a real unit file", () => {
    const host: Host = {
      ...pi5,
      repo: "/srv/marquee",
      home: "/var/lib/marquee",
      user: "mq",
    };
    const amp = ASSETS.find((a) => a.id === "amp-unit")!;
    const rendered = render(
      readFileSync(join(repoRoot, amp.source), "utf8"),
      host,
    );
    expect(rendered).not.toContain(CANONICAL_REPO);
    expect(rendered).toContain("/srv/marquee/packages/amp/dist/server.js");
  });
});

describe("the units this repo now tracks", () => {
  // These existed only as prose to copy-paste out of three different documents, which is how the
  // Backdrop unit came to have two names. Tracking them is what lets the deployer converge them; a
  // unit that regressed to a relative ExecStart or lost its restart policy would be a silent outage.
  const unitText = (id: string) =>
    readFileSync(
      join(repoRoot, ASSETS.find((a) => a.id === id)!.source),
      "utf8",
    );

  it.each(["conductor-unit", "backdrop-unit", "amp-unit", "stylus-unit"])(
    "%s restarts on failure and logs to journald",
    (id) => {
      const text = unitText(id);
      expect(text).toMatch(/^Restart=(always|on-failure)$/m);
      // A log file on the SD card grows forever and wears the card out.
      expect(text).toMatch(/^StandardOutput=journal$/m);
      expect(text).toMatch(/^WantedBy=multi-user\.target$/m);
    },
  );

  it.each(["conductor-unit", "backdrop-unit", "amp-unit"])(
    "%s waits for the network before starting",
    (id) => {
      // The Pi regularly finishes booting before the LAN is routable; without this the first
      // requests after every reboot fail against an unreachable bridge or an unroutable LAN.
      expect(unitText(id)).toMatch(/^After=network-online\.target$/m);
      expect(unitText(id)).toMatch(/^Wants=network-online\.target$/m);
    },
  );

  it.each(["conductor-unit", "backdrop-unit", "amp-unit"])(
    "%s starts node by absolute path",
    (id) => {
      // systemd does not search PATH, and a relative ExecStart only works by accident of
      // WorkingDirectory. Being explicit is what makes the file safe to render for another layout.
      expect(unitText(id)).toMatch(
        /^ExecStart=\/usr\/bin\/node \/home\/pi\/Marquee\//m,
      );
    },
  );

  it("keeps the kiosk autostart entry a launcher and nothing more", () => {
    // Every Chromium flag belongs in kiosk.sh, where deploy-assets.test.ts can see it. A flag added
    // here instead would be invisible to that guard.
    const entry = unitText("kiosk-autostart");
    expect(entry).toContain("kiosk.sh");
    expect(entry).not.toContain("chromium");
  });
});
