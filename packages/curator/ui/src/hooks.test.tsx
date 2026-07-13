import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePoll } from "./hooks";

// Flush the microtasks an async fetcher resolves on (fake timers don't fake promises).
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("usePoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Reset visibility for the next test.
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
  });

  it("fetches on mount and once per interval", async () => {
    const fetcher = vi.fn().mockResolvedValue("ok");
    renderHook(() => usePoll(fetcher, 1000));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("pauses while the tab is hidden and resumes (with an immediate fetch) on return", async () => {
    const fetcher = vi.fn().mockResolvedValue("ok");
    renderHook(() => usePoll(fetcher, 1000));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1); // no polling while hidden

    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2); // immediate fetch on return
  });

  it("refresh() triggers an immediate refetch", async () => {
    const fetcher = vi.fn().mockResolvedValue("ok");
    const { result } = renderHook(() => usePoll(fetcher, 1_000_000));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("surfaces a fetch failure as error, not a throw", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePoll(fetcher, 1000));
    await flush();
    expect(result.current.error).toBe("boom");
    expect(result.current.data).toBeNull();
  });
});
