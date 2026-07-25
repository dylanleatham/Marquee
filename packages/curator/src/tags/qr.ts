// QR for the tag payload (issue #102 / curator-spec §Tag writing).
//
// Why this exists: writing a sticker by hand means retyping `curator:album:2k7bxq9m`, and getting it
// wrong fails *silently* — the tag writes fine and simply never resolves at scan time. Pointing a
// phone at a QR removes the transcription step entirely, which is the only step a human can get
// wrong here. The Flipper path (`tag.nfc`) never needed it; the phone path did.
import QRCode from "qrcode";

/**
 * An SVG data URL for a tag payload, safe to drop straight into an `<img src>`.
 *
 * SVG rather than PNG so it stays crisp at whatever size the Ship workstation renders it, and stays
 * legible when someone zooms in to scan from an awkward angle. Error correction is **M**: these are
 * short, fixed-charset payloads shown on a screen, so the extra redundancy of Q/H would only make
 * the modules smaller and harder to scan for no real-world gain.
 */
export async function tagQrDataUrl(payload: string): Promise<string> {
  const svg = await QRCode.toString(payload, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2, // the quiet zone scanners need; without it, edge modules are unreliable
  });
  // Base64 rather than percent-encoding: the SVG contains `#` and quotes, which are fiddly to escape
  // correctly in a data URL and a common source of "works in one browser" bugs.
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
