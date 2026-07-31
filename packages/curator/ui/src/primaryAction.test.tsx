// The ⌘⏎ slot (curator-ui-ux §9.1, ADR 0044). The registry has three properties worth pinning, and
// each of them is a bug that was easy to write instead:
//
//   * The callable must be the *current* one — Look's primary saves the palette draft, and a copy
//     captured when the bench mounted would save the colours you started with.
//   * Switching benches must hand the slot over cleanly. React runs every cleanup before any new
//     effect, so an unguarded release lets the outgoing workstation wipe the incoming one.
//   * A disabled action must not fire, and re-registering every render must not loop.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import {
  PrimaryActionProvider,
  useFirePrimaryAction,
  usePrimaryAction,
  usePrimaryActionHint,
} from "./primaryAction";

afterEach(cleanup);

/** Renders the hint the bench header would show, plus a button that fires the action. */
function Harness({ children }: { children?: React.ReactNode }) {
  const hint = usePrimaryActionHint();
  const fire = useFirePrimaryAction();
  return (
    <>
      <div data-testid="hint">
        {hint ? `${hint.label}|${hint.disabledReason ?? ""}` : "none"}
      </div>
      <button onClick={() => fire()}>fire</button>
      {children}
    </>
  );
}

function Bench({
  label,
  onRun,
  disabledReason,
}: {
  label: string;
  onRun: () => void;
  disabledReason?: string;
}) {
  usePrimaryAction({
    label,
    run: onRun,
    ...(disabledReason ? { disabledReason } : {}),
  });
  return null;
}

const hint = () => screen.getByTestId("hint").textContent;
const fire = () => fireEvent.click(screen.getByText("fire"));

describe("usePrimaryAction", () => {
  it("publishes the label for the header and fires the action", () => {
    const run = vi.fn();
    render(
      <PrimaryActionProvider>
        <Harness>
          <Bench label="Save palette" onRun={run} />
        </Harness>
      </PrimaryActionProvider>,
    );
    expect(hint()).toBe("Save palette|");
    fire();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports no action when the workstation declares none", () => {
    const Empty = () => {
      usePrimaryAction(null);
      return null;
    };
    render(
      <PrimaryActionProvider>
        <Harness>
          <Empty />
        </Harness>
      </PrimaryActionProvider>,
    );
    expect(hint()).toBe("none");
    expect(fire).not.toThrow();
  });

  it("refuses to fire a disabled action, and says why in the hint", () => {
    const run = vi.fn();
    render(
      <PrimaryActionProvider>
        <Harness>
          <Bench label="Save palette" onRun={run} disabledReason="no changes" />
        </Harness>
      </PrimaryActionProvider>,
    );
    expect(hint()).toBe("Save palette|no changes");
    fire();
    expect(run).not.toHaveBeenCalled();
  });

  it("fires the current closure, not the one captured at registration", () => {
    const seen: number[] = [];
    function Counter() {
      const [n, setN] = useState(0);
      // `run` closes over `n` — the palette editor's draft has exactly this shape.
      usePrimaryAction({
        label: "Save",
        run: () => {
          seen.push(n);
        },
      });
      return <button onClick={() => setN(n + 1)}>bump</button>;
    }
    render(
      <PrimaryActionProvider>
        <Harness>
          <Counter />
        </Harness>
      </PrimaryActionProvider>,
    );
    fire();
    fireEvent.click(screen.getByText("bump"));
    fireEvent.click(screen.getByText("bump"));
    fire();
    expect(seen).toEqual([0, 2]);
  });

  it("hands the slot to the incoming workstation when benches swap", () => {
    const first = vi.fn();
    const second = vi.fn();
    function Swap() {
      const [which, setWhich] = useState<"a" | "b">("a");
      return (
        <>
          <button onClick={() => setWhich("b")}>swap</button>
          {which === "a" ? (
            <Bench label="Save palette" onRun={first} />
          ) : (
            <Bench label="Looks good" onRun={second} />
          )}
        </>
      );
    }
    render(
      <PrimaryActionProvider>
        <Harness>
          <Swap />
        </Harness>
      </PrimaryActionProvider>,
    );
    expect(hint()).toBe("Save palette|");
    fireEvent.click(screen.getByText("swap"));
    // The outgoing bench's cleanup runs before the incoming bench's effect — if it cleared the slot
    // unconditionally, this would read "none" and ⌘⏎ would be dead on the bench you just opened.
    expect(hint()).toBe("Looks good|");
    fire();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("clears the slot when the only workstation unmounts", () => {
    function Toggle() {
      const [on, setOn] = useState(true);
      return (
        <>
          <button onClick={() => setOn(false)}>hide</button>
          {on && <Bench label="Save palette" onRun={() => {}} />}
        </>
      );
    }
    render(
      <PrimaryActionProvider>
        <Harness>
          <Toggle />
        </Harness>
      </PrimaryActionProvider>,
    );
    expect(hint()).toBe("Save palette|");
    fireEvent.click(screen.getByText("hide"));
    expect(hint()).toBe("none");
  });

  it("does not loop when a workstation re-registers on every render", () => {
    let renders = 0;
    function Chatty() {
      renders++;
      // A fresh object and a fresh closure every render — what every real caller does.
      usePrimaryAction({ label: "Save palette", run: () => {} });
      return null;
    }
    render(
      <PrimaryActionProvider>
        <Harness>
          <Chatty />
        </Harness>
      </PrimaryActionProvider>,
    );
    // One render, plus at most the one the first claim triggers. A re-registration loop would run
    // away here instead.
    expect(renders).toBeLessThanOrEqual(2);
  });

  it("is inert outside a provider rather than throwing", () => {
    const Bare = () => {
      usePrimaryAction({ label: "Save", run: () => {} });
      const fireIt = useFirePrimaryAction();
      return <button onClick={() => fireIt()}>bare</button>;
    };
    expect(() => render(<Bare />)).not.toThrow();
    expect(() => fireEvent.click(screen.getByText("bare"))).not.toThrow();
  });
});
