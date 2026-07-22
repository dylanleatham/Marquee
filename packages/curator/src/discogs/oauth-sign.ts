// OAuth 1.0a request signing for Discogs (issue #59 / ADR 0017). Discogs supports the **PLAINTEXT**
// signature method over HTTPS, so the signature is simply `enc(consumerSecret)&enc(tokenSecret)` —
// no base-string/HMAC construction needed. This module builds the `Authorization: OAuth …` header for
// each leg of the 3-legged handshake and for signed API requests. Pure + deterministic (nonce +
// timestamp are inputs, not read from the clock), so it's exhaustively unit-testable.

/** RFC 3986 percent-encoding (stricter than encodeURIComponent — also escapes ! * ' ( )). */
export const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

export interface OAuthHeaderParams {
  consumerKey: string;
  consumerSecret: string;
  /** The request/access token — omitted on the initial request-token leg. */
  token?: string;
  /** The token secret (request- or access-token secret); "" on the request-token leg. */
  tokenSecret?: string;
  /** Only on the request-token leg: where Discogs sends the user back. */
  callback?: string;
  /** Only on the access-token leg: the verifier Discogs handed to the callback. */
  verifier?: string;
  nonce: string;
  /** Unix seconds, as a string. */
  timestamp: string;
}

/**
 * Build the PLAINTEXT `Authorization: OAuth …` header value. The signature is
 * `enc(consumerSecret)&enc(tokenSecret)`; every parameter (including the signature) is
 * percent-encoded in the header per RFC 5849 §3.5.1.
 */
export function oauthHeader(p: OAuthHeaderParams): string {
  const signature = `${rfc3986(p.consumerSecret)}&${rfc3986(p.tokenSecret ?? "")}`;
  const fields: Record<string, string> = {
    oauth_consumer_key: p.consumerKey,
    oauth_nonce: p.nonce,
    oauth_signature_method: "PLAINTEXT",
    oauth_signature: signature,
    oauth_timestamp: p.timestamp,
    oauth_version: "1.0",
  };
  if (p.token) fields.oauth_token = p.token;
  if (p.callback) fields.oauth_callback = p.callback;
  if (p.verifier) fields.oauth_verifier = p.verifier;
  const parts = Object.keys(fields)
    .sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(fields[k]!)}"`);
  return `OAuth ${parts.join(", ")}`;
}

/** Parse a `application/x-www-form-urlencoded` OAuth token response (request/access token legs). */
export function parseTokenResponse(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}
