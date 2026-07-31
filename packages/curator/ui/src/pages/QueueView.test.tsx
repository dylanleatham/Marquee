// The queue's keyboard path (curator-ui-ux §9.1). The success criterion is working through ten
// albums in one session — j/k/Enter is what makes that a session rather than ten round-trips to the
// mouse. Every shortcut here is also a click; these lock in that it never steals a keystroke from a
// field the user is typing into.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { QueueGroups } from "../api";

vi.mock("../api", () => ({
  api: { queue: vi.fn(), pushTagListToFlipper: vi.fn() },
  artworkUrl: (id: string) => `/api/albums/${id}/artwork`,
}));

import { api } from "../api";
import { QueueView } from "./QueueView";

const entry = (curatorId: string, title: string) => ({
  curatorId,
  title,
  artist: "Prince",
  artwork: null,
  state: "awaiting_review" as const,
  subState: null,
  enteredStateAt: "2026-07-25T00:00:00Z",
  lastError: null,
  flags: {},
});

const groups = (): QueueGroups =>
  ({
    awaiting_review: [entry("aaaa1111", "One"), entry("bbbb2222", "Two")],
    awaiting_video: [entry("cccc3333", "Three")],
    awaiting_preview: [],
    awaiting_tag_write: [],
    awaiting_verify: [],
    processing: [],
    errored: [],
    needs_manual: [],
    done_recently: [],
  }) as unknown as QueueGroups;

const renderQueue = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<QueueView />} />
        <Route path="/albums/:curatorId" element={<div>detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );

const selectedTitle = () =>
  document.querySelector(".row--selected .row__title")?.textContent ?? null;

describe("QueueView keyboard navigation", () => {
  beforeEach(() => {
    vi.mocked(api.queue).mockResolvedValue(groups());
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("selects the first row once the queue loads", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));
  });

  it("moves the selection with j and k, across section boundaries", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selectedTitle()).toBe("Two"));

    // "Three" lives in a different section — the flattened order reads the way the page does.
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selectedTitle()).toBe("Three"));

    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(selectedTitle()).toBe("Two"));
  });

  it("clamps at both ends rather than wrapping", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));

    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(selectedTitle()).toBe("One"));

    for (let i = 0; i < 6; i++) fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selectedTitle()).toBe("Three"));
  });

  it("opens the selected album on Enter", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selectedTitle()).toBe("Two"));
    fireEvent.keyDown(window, { key: "Enter" });

    expect(await screen.findByText("detail page")).toBeTruthy();
  });

  /**
   * Issue #119. React commits the rows to the DOM *before* it flushes passive effects, so there is
   * a window where the queue is painted and looks interactive but the keydown listener is still the
   * one captured while the queue was empty — where `j` clamps to `Math.min(c + 1, 0)` and `Enter`
   * sees no selection. A keystroke in that window was silently discarded.
   *
   * Firing from a MutationObserver callback lands in that window deterministically: the callback is
   * a microtask queued by the DOM mutation itself, which runs before React's passive-effect flush.
   * Every other test here waits for the loaded state first, so none of them could ever catch this —
   * it only ever showed up as a 1-in-12 CI flake.
   */
  const pressOnFirstPaint = (key: string) =>
    new Promise<void>((resolve) => {
      const obs = new MutationObserver(() => {
        if (!document.querySelector(".row")) return;
        obs.disconnect();
        fireEvent.keyDown(window, { key });
        resolve();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });

  /**
   * The deterministic half of #119. The two tests below reproduce the bug but only probabilistically
   * — they race React's flush order, which is exactly the property that made it a CI flake instead
   * of a failure. This one pins the fix's mechanism directly: the handler reads rows and cursor from
   * refs, so it depends on nothing that changes, and therefore subscribes exactly once. A listener
   * re-created whenever the data changes is a listener that can be holding last render's data.
   */
  it("subscribes its key handler once, not per data change (#119)", async () => {
    // Fresh objects on every poll, so anything keyed on data identity would re-subscribe.
    vi.mocked(api.queue).mockImplementation(async () => groups());
    const add = vi.spyOn(window, "addEventListener");
    const keydownSubs = () =>
      add.mock.calls.filter(([type]) => type === "keydown").length;

    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));
    expect(keydownSubs()).toBe(1);

    // Moving the selection must not swap it either.
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selectedTitle()).toBe("Two"));
    expect(keydownSubs()).toBe(1);

    add.mockRestore();
  });

  it("doesn't swallow j pressed the instant the rows appear (#119)", async () => {
    renderQueue();
    await pressOnFirstPaint("j");
    await waitFor(() => expect(selectedTitle()).toBe("Two"));
  });

  it("doesn't swallow Enter pressed the instant the rows appear (#119)", async () => {
    renderQueue();
    await pressOnFirstPaint("Enter");
    // Enter read a null selection in that window and did nothing at all.
    expect(await screen.findByText("detail page")).toBeTruthy();
  });

  it("focuses search on /", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));

    fireEvent.keyDown(window, { key: "/" });

    expect(document.activeElement).toBe(
      screen.getByPlaceholderText(/Search title or artist/),
    );
  });

  // The rule that keeps a shortcut from eating a search query.
  it("never hijacks a keystroke aimed at a field", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));
    const search = screen.getByPlaceholderText(/Search title or artist/);

    fireEvent.keyDown(search, { key: "j" });

    expect(selectedTitle()).toBe("One"); // selection did not move
  });

  it("blurs the search field on Escape instead of navigating", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));
    const search = screen.getByPlaceholderText(
      /Search title or artist/,
    ) as HTMLInputElement;
    search.focus();

    fireEvent.keyDown(search, { key: "Escape" });

    expect(document.activeElement).not.toBe(search);
  });

  it("keeps a valid selection when filtering shrinks the list", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selectedTitle()).toBe("Three"));

    fireEvent.change(screen.getByPlaceholderText(/Search title or artist/), {
      target: { value: "One" },
    });

    // The cursor was past the end of the filtered list; it clamps rather than selecting nothing.
    await waitFor(() => expect(selectedTitle()).toBe("One"));
  });
});

/**
 * The "Send list to Flipper" button (issue #68). It is the only confirmation that the tag list
 * actually reached the SD card, so what it says after a push — success *and* failure — is the
 * behaviour worth pinning, not just that a request went out.
 */
describe("QueueView — send tag list to Flipper", () => {
  const withPending = (): QueueGroups =>
    ({
      ...groups(),
      awaiting_tag_write: [entry("dddd4444", "Purple Rain")],
    }) as unknown as QueueGroups;

  beforeEach(() => {
    vi.mocked(api.queue).mockResolvedValue(withPending());
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const button = () =>
    screen.getByRole("button", { name: /send list to flipper/i });

  it("offers the button on the awaiting-tag-write section", async () => {
    renderQueue();
    await waitFor(() => expect(button()).toBeTruthy());
  });

  it("does not offer it when nothing is awaiting a tag write", async () => {
    vi.mocked(api.queue).mockResolvedValue(groups());
    renderQueue();
    await waitFor(() =>
      expect(screen.getByText("Awaiting review")).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: /send list to flipper/i }),
    ).toBeNull();
  });

  it("reports how much landed, and where, on success", async () => {
    vi.mocked(api.pushTagListToFlipper).mockResolvedValue({
      ok: true,
      albums: 1,
      port: "COM6",
      bytes: 48,
      path: "/ext/apps_data/marquee_tag_writer/pending.csv",
    });
    renderQueue();
    await waitFor(() => expect(button()).toBeTruthy());
    fireEvent.click(button());

    await waitFor(() =>
      expect(
        screen.getByText(/Sent 1 album \(48 bytes\) to COM6/),
      ).toBeTruthy(),
    );
    // Stated in words, not by colour alone.
    expect(screen.getByText(/Done\./)).toBeTruthy();
  });

  it("shows the server's reason when there is no Flipper attached", async () => {
    vi.mocked(api.pushTagListToFlipper).mockRejectedValue(
      new Error(
        "No Flipper found on USB. Plug it in, unlock it, and try again.",
      ),
    );
    renderQueue();
    await waitFor(() => expect(button()).toBeTruthy());
    fireEvent.click(button());

    await waitFor(() =>
      expect(screen.getByText(/No Flipper found on USB/)).toBeTruthy(),
    );
    expect(screen.getByText(/Failed:/)).toBeTruthy();
  });

  it("disables the button while a push is in flight", async () => {
    type PushResult = Awaited<ReturnType<typeof api.pushTagListToFlipper>>;
    let release: (v: PushResult) => void = () => {};
    vi.mocked(api.pushTagListToFlipper).mockReturnValue(
      new Promise<PushResult>((r) => {
        release = r;
      }),
    );
    renderQueue();
    await waitFor(() => expect(button()).toBeTruthy());
    fireEvent.click(button());

    await waitFor(() => {
      const busy = screen.getByRole("button", {
        name: /sending to flipper/i,
      }) as HTMLButtonElement;
      expect(busy.disabled).toBe(true);
    });
    release({ ok: true, albums: 1, port: "COM6", bytes: 48, path: "p" });
  });
});
