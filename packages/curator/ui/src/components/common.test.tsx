import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { AlbumThumb, AsyncButton, Cover, StateBadge } from "./common";

afterEach(cleanup);

// The cover <img> is decorative (alt=""), so it has no "img" role — query it directly.
const img = (root: HTMLElement) => root.querySelector("img");

describe("AlbumThumb", () => {
  it("renders the cover img keyed on the artwork endpoint", () => {
    const { container } = render(
      <AlbumThumb curatorId="abcd1234" title="Purple Rain" />,
    );
    expect(img(container)?.getAttribute("src")).toBe(
      "/api/albums/abcd1234/artwork",
    );
  });

  it("falls back to a two-letter monogram when the image 404s", () => {
    const { container } = render(
      <AlbumThumb curatorId="abcd1234" title="Purple Rain" />,
    );
    fireEvent.error(img(container)!);
    expect(screen.getByText("PR")).toBeTruthy();
    expect(img(container)).toBeNull();
  });

  // Issue #25: on a polling page, a transient 404 (art not downloaded yet) latched the placeholder
  // forever. When Roadie later writes the art, the freshness token changes and the cover must
  // re-request rather than waiting for a remount.
  it("recovers from a transient 404 when the artwork version changes", () => {
    const { container, rerender } = render(
      <AlbumThumb curatorId="abcd1234" title="Purple Rain" version={null} />,
    );
    fireEvent.error(img(container)!);
    expect(img(container)).toBeNull();

    rerender(
      <AlbumThumb
        curatorId="abcd1234"
        title="Purple Rain"
        version="deadbeef"
      />,
    );
    const el = img(container);
    expect(el).not.toBeNull();
    expect(el?.getAttribute("src")).toBe(
      "/api/albums/abcd1234/artwork?v=deadbeef",
    );
  });
});

// Issue #134: before the cover lands, both components mounted an <img> whose src is known to 404,
// so the browser painted its broken-image glyph and only then fell back to the monogram. Both read
// as "this art is broken" when it is merely still downloading.
describe("artwork while Roadie is still working", () => {
  const loader = (root: HTMLElement) =>
    root.querySelector('[data-art="loading"]');

  it("AlbumThumb issues no artwork request while the album is processing", () => {
    const { container } = render(
      <AlbumThumb
        curatorId="abcd1234"
        title="Purple Rain"
        state="downloading_art"
      />,
    );
    expect(img(container)).toBeNull();
    expect(loader(container)).not.toBeNull();
  });

  it("AlbumThumb does not show the monogram while processing — that means absent, not pending", () => {
    const { container } = render(
      <AlbumThumb curatorId="abcd1234" title="Purple Rain" state="fresh" />,
    );
    expect(screen.queryByText("PR")).toBeNull();
    expect(loader(container)).not.toBeNull();
  });

  it("AlbumThumb requests the cover once the album leaves the processing states", () => {
    const { container, rerender } = render(
      <AlbumThumb
        curatorId="abcd1234"
        title="Purple Rain"
        state="downloading_art"
      />,
    );
    expect(img(container)).toBeNull();

    rerender(
      <AlbumThumb
        curatorId="abcd1234"
        title="Purple Rain"
        state="awaiting_review"
        version="deadbeef"
      />,
    );
    expect(img(container)?.getAttribute("src")).toBe(
      "/api/albums/abcd1234/artwork?v=deadbeef",
    );
  });

  it("Cover issues no artwork request while the album is processing", () => {
    const { container } = render(
      <Cover
        curatorId="abcd1234"
        title="Purple Rain"
        state="generating_palette"
      />,
    );
    expect(img(container)).toBeNull();
    expect(screen.queryByText("PR")).toBeNull();
    expect(loader(container)).not.toBeNull();
  });

  it("keeps the img unpainted until it actually loads", () => {
    // The request is in flight the moment the element mounts, and the glyph is what the browser
    // paints in the gap. Hiding the element until onLoad closes that window for every caller —
    // including the ones that pass no state at all.
    const { container } = render(
      <AlbumThumb curatorId="abcd1234" title="Purple Rain" />,
    );
    expect(img(container)?.style.display).toBe("none");

    fireEvent.load(img(container)!);
    expect(img(container)?.style.display).toBe("");
  });

  it("distinguishes pending from absent by more than colour", () => {
    // curator-ui-ux §3.4: never colour alone. Pending is motion (a pulsing skeleton), absent is
    // text (the monogram) — two different channels, so they can't be confused.
    const { container: pending } = render(
      <Cover curatorId="abcd1234" title="Purple Rain" state="fresh" />,
    );
    const { container: absent } = render(
      <Cover curatorId="abcd1234" title="Purple Rain" state="verified" />,
    );
    fireEvent.error(img(absent)!);

    expect(loader(pending)).not.toBeNull();
    expect(pending.textContent).toBe("");
    expect(loader(absent)).toBeNull();
    expect(absent.textContent).toContain("PR");
  });
});

describe("Cover", () => {
  it("recovers from a transient 404 when the artwork version changes", () => {
    const { container, rerender } = render(
      <Cover curatorId="abcd1234" title="Purple Rain" version={undefined} />,
    );
    fireEvent.error(img(container)!);
    expect(img(container)).toBeNull();
    expect(screen.getByText("PR")).toBeTruthy();

    rerender(
      <Cover curatorId="abcd1234" title="Purple Rain" version="deadbeef" />,
    );
    const el = img(container);
    expect(el).not.toBeNull();
    expect(el?.getAttribute("src")).toBe(
      "/api/albums/abcd1234/artwork?v=deadbeef",
    );
  });
});

// Issue #62: the slow generative actions gave no in-flight feedback. AsyncButton is the primitive
// that fixes it — each button owns its own spinner + disabled state for the life of its click.
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

describe("StateBadge", () => {
  it("labels the state and marks processing states for the pulse animation", () => {
    const { container } = render(<StateBadge state="generating_palette" />);
    expect(screen.getByText("Generating palette")).toBeTruthy();
    expect(container.querySelector('[data-processing="true"]')).not.toBeNull();
  });

  it("does not mark a parked state as processing", () => {
    const { container } = render(<StateBadge state="awaiting_review" />);
    expect(screen.getByText("Awaiting review")).toBeTruthy();
    expect(container.querySelector('[data-processing="true"]')).toBeNull();
  });
});
