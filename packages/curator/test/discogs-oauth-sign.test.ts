import { describe, it, expect } from "vitest";
import {
  oauthHeader,
  parseTokenResponse,
  rfc3986,
} from "../src/discogs/oauth-sign.js";

// Parse `k="v"` pairs out of an `OAuth …` header value for assertions.
function fields(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.replace(/^OAuth /, "").matchAll(/(\w+)="([^"]*)"/g))
    out[m[1]!] = decodeURIComponent(m[2]!);
  return out;
}

describe("oauthHeader (PLAINTEXT, issue #59)", () => {
  it("signs the request-token leg with consumer secret + callback, no token", () => {
    const h = oauthHeader({
      consumerKey: "ck",
      consumerSecret: "cs",
      callback: "http://127.0.0.1:4739/api/discogs/auth/callback",
      nonce: "n1",
      timestamp: "1600000000",
    });
    const f = fields(h);
    expect(f.oauth_consumer_key).toBe("ck");
    expect(f.oauth_signature_method).toBe("PLAINTEXT");
    expect(f.oauth_signature).toBe("cs&"); // consumer secret, empty token secret
    expect(f.oauth_callback).toBe(
      "http://127.0.0.1:4739/api/discogs/auth/callback",
    );
    expect(f.oauth_token).toBeUndefined();
    expect(f.oauth_version).toBe("1.0");
  });

  it("signs the access-token leg with the request token secret + verifier", () => {
    const f = fields(
      oauthHeader({
        consumerKey: "ck",
        consumerSecret: "cs",
        token: "reqtok",
        tokenSecret: "reqsec",
        verifier: "v123",
        nonce: "n2",
        timestamp: "1600000001",
      }),
    );
    expect(f.oauth_token).toBe("reqtok");
    expect(f.oauth_signature).toBe("cs&reqsec");
    expect(f.oauth_verifier).toBe("v123");
  });

  it("percent-encodes special characters in secrets per RFC 3986", () => {
    const f = fields(
      oauthHeader({
        consumerKey: "ck",
        consumerSecret: "a b&c",
        token: "t",
        tokenSecret: "x/y",
        nonce: "n",
        timestamp: "1",
      }),
    );
    // enc("a b&c")=a%20b%26c, enc("x/y")=x%2Fy, joined by '&'
    expect(f.oauth_signature).toBe("a%20b%26c&x%2Fy");
  });

  it("rfc3986 escapes the sub-delims encodeURIComponent leaves alone", () => {
    expect(rfc3986("a!*'()")).toBe("a%21%2A%27%28%29");
  });

  it("parses a form-encoded token response", () => {
    expect(
      parseTokenResponse(
        "oauth_token=abc&oauth_token_secret=def&oauth_callback_confirmed=true",
      ),
    ).toEqual({
      oauth_token: "abc",
      oauth_token_secret: "def",
      oauth_callback_confirmed: "true",
    });
  });
});
