// The prompt slot (ADR 0027). Drafting is on request, so the slot has to make three things true:
// an undrafted section offers to draft, an album that already has the artifact doesn't push you to
// spend on prompts you won't read, and a control that costs money doesn't look free.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { PromptSlot } from "./workflow";
import { api, type DraftedPrompt } from "../api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const prompt: DraftedPrompt = {
  variants: [{ text: "A grounded prompt", nudge: "cover in motion" }],
  selectedIndex: 0,
  generator: "gemini",
  template: "narrative",
  generatedAt: "2026-07-25T00:00:00Z",
} as DraftedPrompt;

const renderSlot = (over: Partial<Parameters<typeof PromptSlot>[0]> = {}) =>
  render(
    <PromptSlot
      curatorId="abcd1234"
      type="video"
      hasArtifact={false}
      run={async (fn) => {
        await fn();
      }}
      {...over}
    />,
  );

describe("PromptSlot", () => {
  it("offers to draft when nothing has been drafted yet", () => {
    renderSlot();
    expect(screen.getByText("Draft video prompts")).toBeTruthy();
    // And explains why it's empty, rather than looking broken.
    expect(screen.getByText(/Drafting is on request/)).toBeTruthy();
  });

  it("drafts on click", async () => {
    const draftPrompt = vi
      .spyOn(api, "draftPrompt")
      .mockResolvedValue({ promptDrafts: { video: prompt } } as never);
    renderSlot();

    fireEvent.click(screen.getByText("Draft video prompts"));

    await waitFor(() =>
      expect(draftPrompt).toHaveBeenCalledWith("abcd1234", "video"),
    );
  });

  // The case ADR 0027 exists for: you already have the video, so don't push prompts at all.
  it("demotes drafting to a secondary action when the artifact already exists", () => {
    renderSlot({ hasArtifact: true });
    const btn = screen.getByText("Draft video prompts").closest("button")!;
    expect(btn.className).not.toContain("btn--primary");
    expect(screen.getByText(/nothing has been spent on them/)).toBeTruthy();
  });

  // curator-ui-ux §7 rule 3: spending must be legible, not styled like the free Copy button.
  it("marks the draft button as a spending action", () => {
    renderSlot();
    const btn = screen.getByText("Draft video prompts").closest("button")!;
    expect(btn.className).toContain("btn--spend");
    expect(btn.getAttribute("title")).toMatch(/Costs API calls/);
  });

  // Once prompts exist, PromptBlock owns regeneration — the slot must not add a competing button.
  it("shows the drafted prompts once they exist, without a second draft button", () => {
    renderSlot({ prompt });
    expect(screen.getByText(/A grounded prompt/)).toBeTruthy();
    expect(screen.queryByText(/^Draft video prompts$/)).toBeNull();
  });

  it("notes the artifact already exists when showing prompts anyway", () => {
    renderSlot({ prompt, hasArtifact: true });
    expect(screen.getByText(/already have the visualizer/)).toBeTruthy();
  });

  it("labels the card-art slot with its own noun", () => {
    renderSlot({ type: "cardArt" });
    expect(screen.getByText("Draft card-art prompts")).toBeTruthy();
  });
});
