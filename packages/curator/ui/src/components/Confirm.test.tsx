// In-app confirmation (curator-ui-ux §2). window.confirm can't be styled, renders as OS chrome in an
// app that otherwise owns its surface, and blocks the renderer — but the call site should still read
// like a simple await, so these lock down the promise contract as much as the markup.
import { describe, it, expect, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { ConfirmProvider, useConfirm } from "./Confirm";

afterEach(cleanup);

function Harness({ onResult }: { onResult: (ok: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      onClick={async () =>
        onResult(
          await confirm({
            title: "Delete Purple Rain?",
            body: "This can't be undone.",
            confirmLabel: "Delete album",
            destructive: true,
          }),
        )
      }
    >
      open
    </button>
  );
}

const open = (onResult: (ok: boolean) => void) => {
  render(
    <ConfirmProvider>
      <Harness onResult={onResult} />
    </ConfirmProvider>,
  );
  fireEvent.click(screen.getByText("open"));
};

describe("ConfirmProvider", () => {
  it("shows the request and resolves true on confirm", async () => {
    let result: boolean | null = null;
    open((ok) => (result = ok));

    expect(screen.getByText("Delete Purple Rain?")).toBeTruthy();
    expect(screen.getByText("This can't be undone.")).toBeTruthy();
    fireEvent.click(screen.getByText("Delete album"));

    await waitFor(() => expect(result).toBe(true));
    expect(screen.queryByText("Delete Purple Rain?")).toBeNull();
  });

  it("resolves false on cancel", async () => {
    let result: boolean | null = null;
    open((ok) => (result = ok));

    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() => expect(result).toBe(false));
  });

  it("resolves false on Escape", async () => {
    let result: boolean | null = null;
    open((ok) => (result = ok));

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(result).toBe(false));
  });

  it("resolves false when the scrim is clicked", async () => {
    let result: boolean | null = null;
    open((ok) => (result = ok));

    fireEvent.click(document.querySelector(".modal-scrim")!);

    await waitFor(() => expect(result).toBe(false));
  });

  it("does not dismiss when the dialog body itself is clicked", () => {
    let result: boolean | null = null;
    open((ok) => (result = ok));

    fireEvent.click(document.querySelector(".modal")!);

    expect(result).toBeNull();
    expect(screen.getByText("Delete Purple Rain?")).toBeTruthy();
  });

  it("gives a destructive request the alert treatment and an alertdialog role", () => {
    open(() => {});
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(
      screen.getByText("Delete album").closest("button")!.className,
    ).toContain("pp-btn--alert");
  });

  // A missing provider must never make a button silently dead.
  it("falls back to true outside a provider", async () => {
    let result: boolean | null = null;
    render(<Harness onResult={(ok) => (result = ok)} />);
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(result).toBe(true));
  });
});
