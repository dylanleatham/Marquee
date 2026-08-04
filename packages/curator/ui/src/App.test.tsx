// The global keyboard path (curator-ui-ux §9.1): the shortcuts that work from anywhere, and the
// rule they all share — none of them fires while the user is typing into a field, so a search query
// never navigates the app out from under you.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("./api", () => ({
  api: {
    queue: vi.fn().mockResolvedValue({
      awaiting_review: [],
      awaiting_video: [],
      awaiting_preview: [],
      awaiting_tag_write: [],
      awaiting_verify: [],
      processing: [],
      errored: [],
      needs_manual: [],
      done_recently: [],
    }),
    queueCounts: vi.fn().mockResolvedValue({ needsYou: 0 }),
    status: vi.fn().mockResolvedValue({ paused: false, current: null }),
    albums: vi.fn().mockResolvedValue({ albums: [] }),
    pushTagListToFlipper: vi.fn(),
  },
  artworkUrl: (id: string) => `/api/albums/${id}/artwork`,
}));
// The batch reattach is a startup side effect with its own tests; it has nothing to say about keys.
vi.mock("./batchJob", () => ({
  attachRunningBatch: vi.fn().mockResolvedValue(undefined),
  useBatchJob: () => ({ job: null, error: null, unreachable: false }),
  cancelBatch: vi.fn(),
  dismissBatch: vi.fn(),
}));

vi.mock("./discogsSyncJob", () => ({
  attachRunningDiscogsSync: vi.fn().mockResolvedValue(undefined),
  useDiscogsSyncJob: () => ({ job: null, error: null, unreachable: false }),
  cancelDiscogsSync: vi.fn(),
  dismissDiscogsSync: vi.fn(),
}));

import { App } from "./App";

const renderApp = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );

const palette = () => screen.queryByRole("dialog");

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("App — global shortcuts", () => {
  it("opens the command palette on ⌘K", async () => {
    renderApp();
    expect(palette()).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("opens it on Ctrl+K too, and with the shift key down", async () => {
    renderApp();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox"), {
      key: "Escape",
    });
    await waitFor(() => expect(palette()).toBeNull());
    // Caps lock or a held shift sends "K" — a shortcut that only works in lower case is one that
    // intermittently does nothing, which §9.1 rules out.
    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("is reachable by mouse from the header, not only by keyboard", async () => {
    renderApp();
    fireEvent.click(screen.getByTitle(/Jump to an album/i));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("does not open while the user is typing in a field", async () => {
    renderApp();
    const search = await screen.findByPlaceholderText(/Search title or artist/);
    fireEvent.keyDown(search, { key: "k", metaKey: true, bubbles: true });
    expect(palette()).toBeNull();
  });
});
