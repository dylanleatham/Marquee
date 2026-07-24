import { describe, it, expect } from "vitest";
import { parseFavoriteBinding } from "../src/sonos/binding.js";

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
