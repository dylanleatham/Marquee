import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(cleanup);

// A child that throws on render — the exact failure that used to blank the whole app (issue #63).
function Boom({ message = "kaboom" }: { message?: string }): JSX.Element {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  // React logs caught render errors to console.error; silence it so the suite output stays clean.
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("renders children unchanged when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all good")).toBeTruthy();
  });

  it("renders the fallback (with the error message) instead of unmounting when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom message="detail page exploded" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("detail page exploded")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("logs the caught error to console.error for the shell to capture", () => {
    render(
      <ErrorBoundary>
        <Boom message="logged please" />
      </ErrorBoundary>,
    );
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(
      logged.some((args) =>
        args.some(
          (a) => typeof a === "string" && a.includes("[curator-ui] render"),
        ),
      ),
    ).toBe(true);
  });

  it("clears the caught error when resetKey changes (navigating away recovers)", () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/albums/broken">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();

    rerender(
      <ErrorBoundary resetKey="/">
        <p>recovered</p>
      </ErrorBoundary>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("recovered")).toBeTruthy();
  });

  it("applies the variant class so app-level and route-level fallbacks size differently", () => {
    const { container } = render(
      <ErrorBoundary variant="app">
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.querySelector(".error-fallback--app")).not.toBeNull();
  });
});
