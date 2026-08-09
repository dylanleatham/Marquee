// The one part of `api` that isn't `fetch`: the multipart POST that reports its own progress.
//
// `fetch` has no upload-progress event, and a visualizer is a several-hundred-megabyte file — so the
// panel could only say "something is happening", never how much of it (issue #284). XHR is the only
// browser API that reports it, which means this one call site has its own error mapping to get
// right, and that mapping is what these cover.
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
