// The tag-writing help page (issue #103). It replaced a free-text "placement guide" field, so what
// it must actually do is teach: cover both writing paths end to end, and lead with the two mistakes
// that are silent or irreversible.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { TagHelp } from "./TagHelp";

afterEach(cleanup);

const renderAt = (path = "/help/tags") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/help/tags" element={<TagHelp />} />
        <Route path="/" element={<div>queue</div>} />
      </Routes>
    </MemoryRouter>,
  );

const tab = (name: RegExp) => screen.getByRole("tab", { name });

describe("TagHelp", () => {
  it("defaults to the phone path", () => {
    renderAt();
    expect(tab(/Phone/).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/Writing with a phone/)).toBeTruthy();
  });

  it("switches to the Flipper path", () => {
    renderAt();
    fireEvent.click(tab(/Flipper/));
    expect(screen.getByText(/Writing with a Flipper Zero/)).toBeTruthy();
    expect(screen.queryByText(/Writing with a phone/)).toBeNull();
  });

  // Deep-linkable so Ship (or the app menu) can drop you straight at the method you use.
  it("opens the Flipper path directly from the URL", () => {
    renderAt("/help/tags?path=flipper");
    expect(tab(/Flipper/).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/Writing with a Flipper Zero/)).toBeTruthy();
  });

  it("falls back to the phone path for an unknown ?path", () => {
    renderAt("/help/tags?path=nonsense");
    expect(tab(/Phone/).getAttribute("aria-selected")).toBe("true");
  });

  // The silent failure: each object carries a different URI (ADR 0034, ADR 0058), and writing the
  // wrong one produces a tag that works perfectly and does the wrong thing.
  it("explains what each kind does and that getting it wrong fails quietly", () => {
    renderAt();
    expect(screen.getByText(/three tags are not interchangeable/)).toBeTruthy();
    expect(screen.getByText(/fails\s+quietly/)).toBeTruthy();
    expect(screen.getByText("curator:album:…")).toBeTruthy();
    expect(screen.getByText("curator:card:…")).toBeTruthy();
    expect(screen.getByText("curator:demo:…")).toBeTruthy();
  });

  // The irreversible one.
  it("warns against lock and password pages", () => {
    renderAt();
    expect(screen.getByText(/Never set lock or password pages/)).toBeTruthy();
    expect(screen.getByText(/one-way/)).toBeTruthy();
  });

  it("covers both paths' key steps rather than gesturing at them", () => {
    renderAt();
    // Phone: the app, the QR shortcut, and the record type.
    expect(screen.getAllByText(/NFC Tools/).length).toBeGreaterThan(0);
    expect(screen.getByText(/scan the QR/)).toBeTruthy();

    fireEvent.click(tab(/Flipper/));
    // Flipper: the download, where it goes, and the menu path.
    expect(screen.getByText(/\.nfc/)).toBeTruthy();
    expect(screen.getByText("/ext/nfc/")).toBeTruthy();
    expect(screen.getByText(/Saved/)).toBeTruthy();
  });

  it("tells you how to check the tag actually works", () => {
    renderAt();
    expect(screen.getByText(/Room rehearsal/)).toBeTruthy();
    expect(screen.getByText(/Verify physical/)).toBeTruthy();
  });

  it("keeps the placement guidance the old settings field was for", () => {
    renderAt();
    expect(screen.getByText(/Where to stick it/)).toBeTruthy();
    expect(screen.getByText(/upper-right/)).toBeTruthy();
  });
});
