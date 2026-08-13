// The inventory is the one place a deploy can be misconfigured, and most of the ways it can be wrong
// are silent on a good day and destructive on a bad one — a wrong unit name restarts nothing, a
// service listed twice makes "deployed" ambiguous. Every rejection here is a failure that would
// otherwise surface partway through a deploy, with services already restarted.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError,
  HOST_ORDER,
  hostFor,
  isLocal,
  parseConfig,
} from "../src/hosts.js";

const pi5 = {
  ssh: "pi@backdrop.local",
  repo: "/home/pi/Marquee",
  kiosk: true,
  services: {
    conductor: { unit: "marquee-conductor", port: 4737 },
    backdrop: { unit: "backdrop", port: 4740 },
  },
};
const workstation = {
  repo: "C:/dev/Marquee",
  user: "dylan",
  services: { curator: { port: 4739 } },
};

const config = (hosts: Record<string, unknown>) => parseConfig({ hosts });

describe("parsing an inventory", () => {
  it("accepts the tracked example file", () => {
    // The example is what every operator starts from; if it doesn't parse, the first run of the
    // deployer fails on a file this repo shipped.
    const example = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "hosts.example.json"),
        "utf8",
      ),
    );
    const hosts = parseConfig(example);
    expect(hosts.map((h) => h.name)).toEqual(["pi5", "pizero", "workstation"]);
  });

  it("infers the account from the ssh target", () => {
    const [host] = config({ pi5 });
    expect(host!.user).toBe("pi");
    expect(host!.home).toBe("/home/pi");
  });

  it("lets an explicit user override the inferred one", () => {
    const [host] = config({ pi5: { ...pi5, user: "marquee" } });
    expect(host!.user).toBe("marquee");
    expect(host!.home).toBe("/home/marquee");
  });

  it("knows root's home isn't /home/root", () => {
    const [host] = config({ pi5: { ...pi5, ssh: "root@backdrop.local" } });
    expect(host!.home).toBe("/root");
  });

  it("treats a host with no ssh as local", () => {
    const [host] = config({ workstation });
    expect(isLocal(host!)).toBe(true);
  });

  it("finds the host running a given service", () => {
    const hosts = config({ pi5, workstation });
    expect(hostFor(hosts, "backdrop")?.name).toBe("pi5");
    expect(hostFor(hosts, "curator")?.name).toBe("workstation");
    expect(hostFor(hosts, "stylus")).toBeUndefined();
  });
});

describe("deploy order", () => {
  it("puts the Pis before the workstation however the file is written", () => {
    // Not cosmetic: Curator is the only service that pushes, and ADR 0073 has it push entries an
    // older Backdrop rejects outright with a 400. A workstation deployed first is a runtime that
    // looks updated and cannot be synced to.
    const pizero = {
      ssh: "pi@marquee-pizero.local",
      repo: "/home/pi/Marquee",
      services: { stylus: { unit: "marquee-stylus", port: 4741 } },
    };
    const hosts = config({ workstation, pizero, pi5 });
    expect(hosts.map((h) => h.name)).toEqual(["pi5", "pizero", "workstation"]);
  });

  it("puts a host the order doesn't name after the ones it does", () => {
    const hosts = config({
      spare: {
        ssh: "pi@spare",
        repo: "/home/pi/Marquee",
        services: { amp: { unit: "a", port: 1 } },
      },
      pi5,
    });
    expect(hosts.map((h) => h.name)).toEqual(["pi5", "spare"]);
  });

  it("names the hosts it orders", () => {
    expect(HOST_ORDER).toEqual(["pi5", "pizero", "workstation"]);
  });
});

describe("rejections", () => {
  const rejects = (hosts: Record<string, unknown>, match: RegExp) =>
    expect(() => config(hosts)).toThrow(match);

  it("rejects a service with no unit name", () => {
    // The Backdrop-naming trap: guessing here gives `Unit marquee-backdrop.service not found`
    // partway through a restart that already touched the other units.
    rejects(
      { pi5: { ...pi5, services: { backdrop: { port: 4740 } } } },
      /needs a "unit"/,
    );
  });

  it("says how to find the real unit name when one is missing", () => {
    expect(() =>
      config({ pi5: { ...pi5, services: { backdrop: { port: 4740 } } } }),
    ).toThrow(/systemctl list-units/);
  });

  it("lets Curator omit a unit, because it has none", () => {
    expect(() => config({ workstation })).not.toThrow();
  });

  it("rejects an unknown service id", () => {
    rejects(
      { pi5: { ...pi5, services: { conducter: { unit: "x", port: 1 } } } },
      /unknown service "conducter"/,
    );
  });

  it("rejects the same service on two hosts", () => {
    // Otherwise "is backdrop deployed?" has two answers, which is precisely what this tool exists
    // to stop being a question.
    rejects(
      {
        pi5,
        other: {
          ssh: "pi@b",
          repo: "/r",
          services: { backdrop: { unit: "b", port: 4740 } },
        },
      },
      /configured on both/,
    );
  });

  it.each([
    [{ pi5: { ...pi5, repo: undefined } }, /needs a "repo"/],
    [{ pi5: { ...pi5, services: {} } }, /lists no services/],
    [
      { pi5: { ...pi5, services: { amp: { unit: "a" } } } },
      /needs an integer "port"/,
    ],
    [
      { pi5: { ...pi5, services: { amp: { unit: "a", port: "4741" } } } },
      /needs an integer "port"/,
    ],
    [
      { pi5: { repo: "/r", services: { amp: { unit: "a", port: 1 } } } },
      /needs a "user"/,
    ],
  ])("rejects a malformed host (%#)", (hosts, match) => {
    rejects(hosts as Record<string, unknown>, match);
  });

  it("rejects a config with no hosts at all", () => {
    expect(() => parseConfig({ hosts: {} })).toThrow(/no hosts/);
    expect(() => parseConfig({})).toThrow(/"hosts" object/);
    expect(() => parseConfig(null)).toThrow(ConfigError);
  });
});
