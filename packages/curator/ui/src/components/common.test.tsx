// What is left of the shared components (ADR 0052).
//
// `AlbumThumb`, `Cover` and `StateBadge` went with the screens that mounted them, and their cases
// went with them: they asserted a monogram placeholder and a machine-state pill, neither of which
// the overhauled screens have. `artworkSrc` outlived them because the freshness token is the part
// that was genuinely shared.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { AsyncButton, artworkSrc, pickFile } from "./common";

afterEach(cleanup);

describe("artworkSrc", () => {
  it("keys the URL on the version, so a late cover actually appears", () => {
    expect(artworkSrc("abc12345", "hash-1")).toBe(
      "/api/albums/abc12345/artwork?v=hash-1",
    );
    // A path is a legal token too, and it has to survive the query string intact.
    expect(artworkSrc("abc12345", "media/art/a.jpg")).toContain(
      "?v=media%2Fart%2Fa.jpg",
    );
  });

  it("falls back to the bare URL when there is nothing to key on", () => {
    expect(artworkSrc("abc12345")).toBe("/api/albums/abc12345/artwork");
    expect(artworkSrc("abc12345", null)).toBe("/api/albums/abc12345/artwork");
  });
});

describe("pickFile", () => {
  it("asks for the kind of file the caller wants, and hands back the pick", () => {
    const onFile = vi.fn();
    const file = new File(["x"], "a.mp4", { type: "video/mp4" });
    const real = document.createElement.bind(document);
    const spy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = real(tag);
        if (tag === "input") {
          Object.defineProperty(el, "files", { value: [file] });
          (el as HTMLInputElement).click = () =>
            (el as HTMLInputElement).onchange?.(new Event("change"));
        }
        return el;
      });
    pickFile("video/*", onFile);
    spy.mockRestore();
    expect(onFile).toHaveBeenCalledWith(file);
  });
});

describe("AsyncButton", () => {
  it("renders its children and is enabled while idle", () => {
    render(<AsyncButton onClick={() => Promise.resolve()}>Go</AsyncButton>);
    const btn = screen.getByRole("button", { name: "Go" });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows spinner + pending label and disables itself in flight, then restores on resolve", async () => {
    let release!: () => void;
    const onClick = vi.fn(() => new Promise<void>((r) => (release = r)));
    render(
      <AsyncButton onClick={onClick} pendingLabel="Working…">
        Go
      </AsyncButton>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);

    // In flight: disabled, spinner shown, label swapped.
    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(screen.getByLabelText("loading")).toBeTruthy();
    expect(screen.getByText("Working…")).toBeTruthy();

    // A second click while pending is ignored (no double-submit).
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() =>
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.getByText("Go")).toBeTruthy();
  });

  it("honors an explicit disabled prop while idle", () => {
    render(
      <AsyncButton onClick={() => Promise.resolve()} disabled>
        Go
      </AsyncButton>,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

// The `StateBadge` cases were removed 2026-08-05 with the component (ADR 0052). They asserted that
// a pill read "Generating palette" and "Awaiting review" — which is now precisely what the UI must
// never say. `needs.test.ts` asserts the replacement rule from the other direction.
