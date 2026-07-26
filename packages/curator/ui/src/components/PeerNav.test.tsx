// "Next album at this state" (issue #94). Two things matter beyond it working at all: navigating
// keeps the workstation you're on — a run of five tag writes shouldn't bounce you back to Look each
// time — and the ends of a run say so instead of wrapping you silently onto an album you finished.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

import type { PeerContext } from "../api";
import { PeerNav } from "./PeerNav";

const ctx = (patch: Partial<PeerContext> = {}): PeerContext => ({
  bucket: "awaiting_tag_write",
  position: 2,
  total: 3,
  prev: { curatorId: "aaaaaaa1", title: "Kind of Blue" },
  next: { curatorId: "ccccccc3", title: "Rumours" },
  ...patch,
});

const show = (peers: PeerContext | null, section?: string) =>
  render(
    <MemoryRouter>
      <PeerNav peers={peers} {...(section ? { section } : {})} />
    </MemoryRouter>,
  );

const prev = () => screen.getByRole("button", { name: /prev/i });
const next = () => screen.getByRole("button", { name: /next/i });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PeerNav", () => {
  it("says where you are in the run, named so you don't have to count", () => {
    show(ctx());
    expect(screen.getByText(/2 of 3/)).toBeTruthy();
    expect(screen.getByText("awaiting tag write")).toBeTruthy();
  });

  it("moves by click and by [ / ]", () => {
    show(ctx());

    fireEvent.click(next());
    expect(navigate).toHaveBeenCalledWith("/albums/ccccccc3");

    fireEvent.keyDown(window, { key: "[" });
    expect(navigate).toHaveBeenCalledWith("/albums/aaaaaaa1");
    // Every shortcut is also a click (curator-ui-ux §9.1) — both paths reach the same place.
    fireEvent.click(prev());
    expect(navigate).toHaveBeenCalledWith("/albums/aaaaaaa1");
  });

  it("keeps the workstation you're on", () => {
    // The point of the affordance: finishing five tag writes in a row shouldn't send you back to
    // Look each time.
    show(ctx(), "ship");
    fireEvent.keyDown(window, { key: "]" });
    expect(navigate).toHaveBeenCalledWith("/albums/ccccccc3/ship");
  });

  it("stops at the ends rather than wrapping, and says why it's disabled", () => {
    show(ctx({ position: 3, next: null }));
    expect((next() as HTMLButtonElement).disabled).toBe(true);
    // A disabled control always carries its reason (curator-ui-ux §10).
    expect(next().getAttribute("title")).toBe("This is the last one");

    fireEvent.keyDown(window, { key: "]" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("stays visible when the album is alone at its state, and explains", () => {
    show(ctx({ position: 1, total: 1, prev: null, next: null }));
    // Present but disabled, not absent — an absent control is indistinguishable from one that
    // doesn't exist (ADR 0026).
    expect((prev() as HTMLButtonElement).disabled).toBe(true);
    expect((next() as HTMLButtonElement).disabled).toBe(true);
    expect(next().getAttribute("title")).toMatch(/No other albums/);
  });

  it("never steals a keystroke aimed at a field", () => {
    show(ctx());
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "]" });
    expect(navigate).not.toHaveBeenCalled();
    input.remove();
  });

  it("renders nothing, and binds nothing, before the peers are known", () => {
    const { container } = show(null);
    expect(container.innerHTML).toBe("");
    fireEvent.keyDown(window, { key: "]" });
    expect(navigate).not.toHaveBeenCalled();
  });
});
