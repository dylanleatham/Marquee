import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AlbumThumb, StateBadge } from "./common";

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
