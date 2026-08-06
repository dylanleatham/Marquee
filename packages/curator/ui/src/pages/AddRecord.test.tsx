// Add a record (ADR 0052). The behaviour that changed is that adding doesn't take you anywhere —
// you came here to add several.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api", () => ({
  api: {
    searchSpotify: vi.fn().mockResolvedValue({
      results: [
        {
          spotifyId: "1",
          spotifyUri: "spotify:album:1",
          name: "Bitches Brew",
          artist: "Miles Davis",
          year: 1970,
        },
        {
          spotifyId: "2",
          spotifyUri: "spotify:album:2",
          name: "Live-Evil",
          artist: "Miles Davis",
          year: 1971,
        },
      ],
    }),
    addSpotify: vi.fn().mockResolvedValue({ curatorId: "new12345" }),
    addManual: vi.fn().mockResolvedValue({ curatorId: "man12345" }),
  },
}));

import { api } from "../api";
import { AddRecord } from "./AddRecord";

const show = (at = "/add") =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <AddRecord />
    </MemoryRouter>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const search = () => screen.getByLabelText(/Search Spotify/i);

const typeIn = (title: string, artist: string, year?: string) => {
  fireEvent.change(screen.getByLabelText("TITLE"), {
    target: { value: title },
  });
  fireEvent.change(screen.getByLabelText("ARTIST"), {
    target: { value: artist },
  });
  if (year)
    fireEvent.change(screen.getByLabelText("YEAR"), {
      target: { value: year },
    });
};

/**
 * Submit the form itself rather than clicking ADD IT: jsdom does not perform implicit form
 * submission from a click on a submit button, so a click here would assert nothing.
 */
const submit = () => fireEvent.submit(document.querySelector("form.typein")!);

/**
 * `fireEvent.change(input, { target: { files } })` does not make the file visible to
 * `new FormData(form)` in this jsdom, so the property is defined on the element directly — which
 * does. There is no `DataTransfer` here either, which is the other usual way to do this.
 */
const attachSleeve = () => {
  const input = screen.getByLabelText("THE SLEEVE");
  Object.defineProperty(input, "files", {
    value: [new File(["cover"], "sleeve.png", { type: "image/png" })],
    configurable: true,
  });
  fireEvent.change(input);
};

describe("AddRecord — searching", () => {
  it("searches as you type and shows the results four up", async () => {
    show();
    fireEvent.change(search(), { target: { value: "bitches brew" } });
    await waitFor(() =>
      expect(api.searchSpotify).toHaveBeenCalledWith("bitches brew"),
    );
    expect(await screen.findByText("Bitches Brew")).toBeTruthy();
    expect(screen.getByText("Miles Davis · 1970")).toBeTruthy();
  });

  it("stays put after adding, and says what has landed", async () => {
    // The old screen jumped to the album you just added, which is exactly wrong for the actual task.
    show();
    fireEvent.change(search(), { target: { value: "bitches brew" } });
    fireEvent.click(await screen.findByText("Bitches Brew"));
    await waitFor(() =>
      expect(api.addSpotify).toHaveBeenCalledWith("spotify:album:1"),
    );
    expect(await screen.findByText(/added just now/)).toBeTruthy();
    expect(screen.getByText(/keep going/)).toBeTruthy();
    // The query is still there, so the next one is one click away.
    expect((search() as HTMLInputElement).value).toBe("bitches brew");
  });

  it("won't add the same result twice", async () => {
    show();
    fireEvent.change(search(), { target: { value: "bitches brew" } });
    // By role: the title also appears in the "added just now" line once it lands.
    const tile = await screen.findByRole("button", { name: /Bitches Brew/ });
    fireEvent.click(tile);
    await waitFor(() => expect(screen.getAllByText("ADDED").length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: /Bitches Brew/ }));
    expect(api.addSpotify).toHaveBeenCalledTimes(1);
  });

  it("arrives with the query already searched when Discogs hands one over", async () => {
    // The other half of the Discogs screen's SEARCH BY HAND link (§8.8). Both ends have to agree, and
    // a test on the href alone passed happily while this end ignored `?q=` entirely.
    show("/add?q=Untitled%20white%20label");
    expect((search() as HTMLInputElement).value).toBe("Untitled white label");
    await waitFor(() =>
      expect(api.searchSpotify).toHaveBeenCalledWith("Untitled white label"),
    );
  });

  it("says so when nothing matches, rather than showing an empty grid", async () => {
    vi.mocked(api.searchSpotify).mockResolvedValue({ results: [] });
    show();
    fireEvent.change(search(), { target: { value: "zzzz" } });
    expect(
      await screen.findByText(/Nothing on Spotify by that name/),
    ).toBeTruthy();
  });

  it("reports a failed search", async () => {
    vi.mocked(api.searchSpotify).mockRejectedValue(
      new Error("Spotify is down"),
    );
    show();
    fireEvent.change(search(), { target: { value: "x" } });
    expect(await screen.findByText(/Spotify is down/)).toBeTruthy();
  });
});

describe("AddRecord — the other ways in", () => {
  it("offers typing it in, and says why the sleeve is required", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "TYPE IT IN" }));
    expect(screen.getByText("THE SLEEVE")).toBeTruthy();
    expect(screen.getByText(/where the lights come from/)).toBeTruthy();
  });

  it("submits what was typed in, and stays put like the search tab does", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "TYPE IT IN" }));
    typeIn("Cold Fact", "Rodriguez", "1970");
    attachSleeve();
    submit();

    await waitFor(() => expect(api.addManual).toHaveBeenCalled());
    const sent = vi.mocked(api.addManual).mock.calls[0]![0] as FormData;
    expect(sent.get("name")).toBe("Cold Fact");
    expect(sent.get("artist")).toBe("Rodriguez");
    expect(sent.get("year")).toBe("1970");
    // Not the sleeve: this jsdom's `FormData` yields an empty `File` for a file input however the
    // file was attached, so asserting on it here would assert on the environment, not the screen.
    // That the sleeve was seen at all is what the missing-sleeve test below pins down.

    expect(await screen.findByText(/added just now/)).toBeTruthy();
    expect(screen.getByText("Cold Fact")).toBeTruthy();
    // Cleared for the next sleeve on the stack — the whole point of not navigating away.
    expect((screen.getByLabelText("TITLE") as HTMLInputElement).value).toBe("");
  });

  it("won't send a record with no sleeve, and says why rather than failing at the server", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "TYPE IT IN" }));
    typeIn("Cold Fact", "Rodriguez");
    submit();
    expect(
      await screen.findByText(/needs a cover to pull its lights from/),
    ).toBeTruthy();
    expect(api.addManual).not.toHaveBeenCalled();
  });

  it("reports a rejected hand-typed record instead of silently doing nothing", async () => {
    vi.mocked(api.addManual).mockRejectedValue(
      new Error("already in the library"),
    );
    show();
    fireEvent.click(screen.getByRole("button", { name: "TYPE IT IN" }));
    typeIn("Cold Fact", "Rodriguez");
    attachSleeve();
    submit();
    expect(await screen.findByText(/already in the library/)).toBeTruthy();
  });

  it("sends you to Discogs rather than pretending it is a tab", () => {
    // Discogs is a standing collection with its own screen (ADR 0051), not a way to pick one record.
    show();
    expect(
      screen.getByRole("link", { name: /SYNC DISCOGS/ }).getAttribute("href"),
    ).toBe("/discogs");
  });

  it("no longer offers to paste a link", () => {
    show();
    expect(screen.queryByText(/paste|uri/i)).toBeNull();
  });
});
