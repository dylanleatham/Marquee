// The one part of `api` that isn't `fetch`: the multipart POST that reports its own progress.
//
// `fetch` has no upload-progress event, and a visualizer is a several-hundred-megabyte file — so the
// panel could only say "something is happening", never how much of it (issue #284). XHR is the only
// browser API that reports it, which means this one call site has its own error mapping to get
// right, and that mapping is what these cover.
//
// Plus the artwork-override pair at the bottom, which are here for a different reason: they encode
// curator-spec §12's answer in the *request itself* — a form field on the way in, a query string on
// the way out — and their only other tests mock `api` wholesale.
import { describe, it, expect, vi, afterEach } from "vitest";
import { api, ApiError } from "./api";

type ProgressEvent = {
  loaded: number;
  total: number;
  lengthComputable: boolean;
};

/** Just enough XMLHttpRequest to drive `postForm`, with the hooks a test needs to answer it. */
class FakeXhr {
  static last: FakeXhr | null = null;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  responseType = "";
  status = 0;
  responseText = "";
  method = "";
  url = "";
  body: FormData | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
    FakeXhr.last = this;
  }
  /** Answer as the server would. */
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ loaded, total, lengthComputable });
  }
}

const install = () => {
  FakeXhr.last = null;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return () => FakeXhr.last!;
};

afterEach(() => vi.unstubAllGlobals());

describe("uploadVideo", () => {
  it("posts the form to the upload route with the album named on it", async () => {
    const xhr = install();
    const form = new FormData();
    form.append("file", new File(["mp4"], "clip.mp4"));
    void api.uploadVideo("abc12345", form);
    expect(xhr().method).toBe("POST");
    expect(xhr().url).toBe("/api/videos/upload");
    expect((xhr().body as FormData).get("curatorId")).toBe("abc12345");
  });

  it("reports bytes as they go out, and resolves with the server's answer", async () => {
    const xhr = install();
    const seen: [number, number][] = [];
    const done = api.uploadVideo("abc12345", new FormData(), {
      onProgress: (sent, total) => seen.push([sent, total]),
    });
    xhr().progress(500, 1000);
    xhr().respond(201, { state: "awaiting_preview" });
    await expect(done).resolves.toEqual({ state: "awaiting_preview" });
    expect(seen).toEqual([[500, 1000]]);
  });

  /** A chunked body has no length; reporting a total of nothing is what tells the strip to drop the
      percentage rather than compute one against zero. */
  it("reports a total of 0 when the browser won't say how big it is", async () => {
    const xhr = install();
    const seen: [number, number][] = [];
    void api.uploadVideo("abc12345", new FormData(), {
      onProgress: (sent, total) => seen.push([sent, total]),
    });
    xhr().progress(500, 0, false);
    expect(seen).toEqual([[500, 0]]);
  });

  it("rejects with the server's own sentence, and its status", async () => {
    const xhr = install();
    const done = api.uploadVideo("abc12345", new FormData());
    xhr().respond(413, { error: "that file is larger than the 2 GB limit" });
    await expect(done).rejects.toThrow(
      "that file is larger than the 2 GB limit",
    );
    await expect(done).rejects.toMatchObject({ status: 413 });
  });

  it("rejects rather than resolving when the connection drops mid-upload", async () => {
    // The case that matters most here: the transfer is long, so it is the one most likely to be cut.
    // Resolving would attach nothing and say it worked.
    const xhr = install();
    const done = api.uploadVideo("abc12345", new FormData());
    xhr().onerror?.();
    await expect(done).rejects.toBeInstanceOf(ApiError);
  });

  it("survives a body that isn't JSON at all", async () => {
    const xhr = install();
    const done = api.uploadVideo("abc12345", new FormData());
    xhr().status = 502;
    xhr().responseText = "<html>Bad Gateway</html>";
    xhr().onload?.();
    await expect(done).rejects.toThrow("HTTP 502");
  });
});

/**
 * The artwork override's two calls, tested against the request they actually build.
 *
 * LightsPanel.test.tsx mocks `api` and therefore asserts the *arguments* — `(id, false)` — which
 * says nothing about whether `false` reaches the server. These two functions are where the §12
 * answer stops being a boolean and becomes a form field or a query string, and each has a branch:
 * invert either one and the hand-edit the dialog just promised to keep is re-derived instead, with
 * every panel test still green. That is the gap this closes.
 *
 * The two routes disagree on purpose (ADR 0084): `POST` omits the field to mean "server's default,
 * which protects a hand-edit", `DELETE` regenerates unless told otherwise. So "absent" means the
 * opposite thing on each, and both absences are asserted.
 */
describe("the artwork override", () => {
  /** `removeArtworkOverride` goes through `fetch`, not the XHR path above. */
  const fakeFetch = () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ artwork: undefined, paletteRegenerated: true }),
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  };

  it("keeps a hand-edit on the way out by saying so in the query string", async () => {
    const fetchSpy = fakeFetch();
    await api.removeArtworkOverride("abc12345", false);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "/api/albums/abc12345/artwork/override?regeneratePalette=false",
    );
    expect(init.method).toBe("DELETE");
  });

  it("sends no query at all when the colours should follow the cover back", async () => {
    // The bare URL is the *regenerating* case here — the opposite of the upload's bare form.
    const fetchSpy = fakeFetch();
    await api.removeArtworkOverride("abc12345", true);
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "/api/albums/abc12345/artwork/override",
    );
  });

  it("defaults to re-deriving, matching the route it calls", async () => {
    const fetchSpy = fakeFetch();
    await api.removeArtworkOverride("abc12345");
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "/api/albums/abc12345/artwork/override",
    );
  });

  it("puts the cover and the §12 answer on the upload's form", () => {
    const xhr = install();
    const file = new File(["png"], "my-scan.png", { type: "image/png" });
    void api.uploadArtworkOverride("abc12345", file, false);
    expect(xhr().method).toBe("POST");
    expect(xhr().url).toBe("/api/albums/abc12345/artwork/override");
    const form = xhr().body as FormData;
    expect(form.get("file")).toBe(file);
    expect(form.get("regeneratePalette")).toBe("false");
  });

  it("says `true` when the user asked for new colours over a hand-edit", () => {
    const xhr = install();
    void api.uploadArtworkOverride(
      "abc12345",
      new File(["png"], "x.png"),
      true,
    );
    expect((xhr().body as FormData).get("regeneratePalette")).toBe("true");
  });

  /**
   * Omitted, not `"undefined"`. `FormData.append` stringifies whatever it is given, so sending the
   * field unconditionally would put the literal text `undefined` on the wire — which the server
   * reads as "not false", i.e. regenerate, silently discarding the hand-edit §12 protects.
   */
  it("leaves the field off entirely when the caller has no answer to give", () => {
    const xhr = install();
    void api.uploadArtworkOverride("abc12345", new File(["png"], "x.png"));
    expect((xhr().body as FormData).has("regeneratePalette")).toBe(false);
  });

  it("reports the upload's bytes, like every other postForm caller", async () => {
    const xhr = install();
    const seen: [number, number][] = [];
    const done = api.uploadArtworkOverride(
      "abc12345",
      new File(["png"], "x.png"),
      true,
      { onProgress: (sent, total) => seen.push([sent, total]) },
    );
    xhr().progress(120, 400);
    xhr().respond(201, { paletteRegenerated: true });
    await expect(done).resolves.toMatchObject({ paletteRegenerated: true });
    expect(seen).toEqual([[120, 400]]);
  });
});
