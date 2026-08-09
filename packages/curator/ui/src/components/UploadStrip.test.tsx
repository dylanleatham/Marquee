// What a file on its way to Curator looks like (issue #284). The panels prove it appears at all;
// these cover the three things it has to get right in the states they can't easily stage.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { UploadStrip } from "./UploadStrip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const text = () => screen.getByRole("status").textContent ?? "";

describe("UploadStrip", () => {
  it("renders nothing when nothing is in flight", () => {
    const { container } = render(<UploadStrip upload={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("carries the numbers as well as the bar", () => {
    render(
      <UploadStrip
        upload={{
          name: "clip.mp4",
          sent: 60 * 1024 * 1024,
          total: 240 * 1024 * 1024,
          startedAt: Date.now(),
        }}
      />,
    );
    expect(text()).toContain("Sending clip.mp4");
    expect(text()).toContain("25%");
    expect(text()).toContain("60.0 MB of 240.0 MB");
    expect(
      (document.querySelector(".bdstrip__fill") as HTMLElement).style.width,
    ).toBe("25%");
  });

  /** A guess made from two bytes is worse than none, because it is believed (`etaSeconds`). */
  it("adds an ETA only once there is enough to say", () => {
    const started = Date.now();
    const { rerender } = render(
      <UploadStrip
        upload={{
          name: "clip.mp4",
          sent: 1024,
          total: 1024 * 1024,
          startedAt: started,
        }}
      />,
    );
    expect(text()).not.toContain("left");

    vi.useFakeTimers();
    vi.setSystemTime(started + 10_000);
    rerender(
      <UploadStrip
        upload={{
          name: "clip.mp4",
          sent: 512 * 1024,
          total: 1024 * 1024,
          startedAt: started,
        }}
      />,
    );
    expect(text()).toContain("left");
  });

  it("drops the percentage when the browser won't say how big the file is", () => {
    render(
      <UploadStrip
        upload={{
          name: "clip.mp4",
          sent: 4096,
          total: 0,
          startedAt: Date.now(),
        }}
      />,
    );
    expect(text()).toContain("Sending clip.mp4");
    expect(text()).not.toContain("%");
    expect(document.querySelector(".bdstrip__bar")).toBeNull();
  });

  it("hands the wait over to the server once every byte is out", () => {
    render(
      <UploadStrip
        upload={{
          name: "clip.mp4",
          sent: 2048,
          total: 2048,
          startedAt: Date.now(),
        }}
      />,
    );
    expect(text()).toContain("Adding clip.mp4 to the record");
    expect(text()).not.toContain("100%");
  });
});
