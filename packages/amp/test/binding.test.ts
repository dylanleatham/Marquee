import { describe, it, expect } from "vitest";
import {
  parseFavoriteBinding,
  patchContainerUri,
  regionFromToken,
  matchRoom,
} from "../src/sonos/binding.js";

// A real Sonos Favorites (FV:2) DIDL captured from the working spike: a Sonos Radio favorite (no
// Spotify binding) followed by a Spotify album favorite carrying sid=12, sn=1, and the SA_RINCON3079
// account token. XML-escaped exactly as ContentDirectoryService.Browse returns it.
const SPOTIFY_FAVORITE_DIDL = `&lt;DIDL-Lite&gt;&lt;item id=&quot;FV:2/0&quot;&gt;&lt;res&gt;&lt;/res&gt;&lt;r:resMD&gt;&amp;lt;desc id=&amp;quot;cdudn&amp;quot;&amp;gt;SA_RINCON77575_X_#Svc77575-0-Token&amp;lt;/desc&amp;gt;&lt;/r:resMD&gt;&lt;/item&gt;&lt;item id=&quot;FV:2/2&quot;&gt;&lt;res protocolInfo=&quot;x-rincon-cpcontainer:*:*:*&quot;&gt;x-rincon-cpcontainer:1004206cspotify%3Aalbum%3A6qb9MDR0lfsN9a2pw77uJy?sid=12&amp;amp;flags=8300&amp;amp;sn=1&lt;/res&gt;&lt;r:resMD&gt;&amp;lt;desc id=&amp;quot;cdudn&amp;quot;&amp;gt;SA_RINCON3079_X_#Svc3079-0-Token&amp;lt;/desc&amp;gt;&lt;/r:resMD&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;`;

// Favorites with only Sonos Radio (no Spotify album favorite).
const NO_SPOTIFY_DIDL = `&lt;DIDL-Lite&gt;&lt;item id=&quot;FV:2/0&quot;&gt;&lt;res&gt;&lt;/res&gt;&lt;r:resMD&gt;&amp;lt;desc id=&amp;quot;cdudn&amp;quot;&amp;gt;SA_RINCON77575_X_#Svc77575-0-Token&amp;lt;/desc&amp;gt;&lt;/r:resMD&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;`;

describe("parseFavoriteBinding", () => {
  it("extracts sid/sn/token from a real Spotify favorite", () => {
    expect(parseFavoriteBinding(SPOTIFY_FAVORITE_DIDL)).toEqual({
      sid: "12",
      sn: "1",
      token: "SA_RINCON3079_X_#Svc3079-0-Token",
    });
  });

  it("picks the Spotify favorite's token, not the Sonos Radio one that precedes it", () => {
    // The Sonos Radio token (SA_RINCON77575) appears first; the binding must come from the album's res.
    expect(parseFavoriteBinding(SPOTIFY_FAVORITE_DIDL)?.token).toContain(
      "3079",
    );
  });

  it("returns null when there is no Spotify album favorite", () => {
    expect(parseFavoriteBinding(NO_SPOTIFY_DIDL)).toBeNull();
    expect(parseFavoriteBinding("")).toBeNull();
  });
});

describe("regionFromToken", () => {
  it("reads the region number out of a cdudn token", () => {
    expect(regionFromToken("SA_RINCON3079_X_#Svc3079-0-Token")).toBe("3079");
    expect(regionFromToken("SA_RINCON2311_X_#Svc2311-0-Token")).toBe("2311");
  });
  it("falls back to US (3079) for an unrecognised token", () => {
    expect(regionFromToken("garbage")).toBe("3079");
  });
});

describe("patchContainerUri", () => {
  const binding = {
    sid: "12",
    sn: "1",
    token: "SA_RINCON3079_X_#Svc3079-0-Token",
  };
  it("replaces the library's hardcoded sid/sn with the real ones", () => {
    const guessed =
      "x-rincon-cpcontainer:1004206cspotify:album:1DFixLWuPkv3KT3TnV35m3?sid=9&flags=8300&sn=7";
    expect(patchContainerUri(guessed, binding)).toBe(
      "x-rincon-cpcontainer:1004206cspotify:album:1DFixLWuPkv3KT3TnV35m3?sid=12&flags=8300&sn=1",
    );
  });
  it("leaves the container id and flags untouched", () => {
    const out = patchContainerUri(
      "x-rincon-cpcontainer:1004206cspotify:album:ABC?sid=9&flags=8300&sn=7",
      binding,
    );
    expect(out).toContain("spotify:album:ABC");
    expect(out).toContain("flags=8300");
  });
});

describe("matchRoom", () => {
  const devices = [
    { Name: "Living Room", GroupName: "Living Room" },
    { Name: "Kitchen", GroupName: "Kitchen + 1" },
    { Name: "Office", GroupName: "Kitchen + 1" }, // a member of the Kitchen group
  ];
  it("matches an exact room name (case-insensitive)", () => {
    expect(matchRoom(devices, "living room")?.Name).toBe("Living Room");
    expect(matchRoom(devices, "Kitchen")?.Name).toBe("Kitchen");
  });
  it("falls back to a group whose name contains the target", () => {
    // No device is named "Office"? it is — but a target that only appears in a group name still hits:
    expect(matchRoom(devices, "Kitchen +")?.Name).toBe("Kitchen");
  });
  it("returns undefined when nothing matches", () => {
    expect(matchRoom(devices, "Bathroom")).toBeUndefined();
    expect(matchRoom([], "Living Room")).toBeUndefined();
  });
});
