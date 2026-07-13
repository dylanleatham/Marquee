import { customAlphabet } from "nanoid";

// Crockford base32, lowercase, no i/l/o/u — 32 symbols, all within [a-z0-9] so ids match the
// contracts pattern ^[a-z0-9]{8}$. 8 chars ≈ 1e12 space; collisions are ~nil but still handled.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const nano = customAlphabet(ALPHABET, 8);

/** Generate an 8-char curatorId that `exists` reports as free. Retries on the rare collision. */
export function generateCuratorId(exists: (id: string) => boolean): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = nano();
    if (!exists(id)) return id;
  }
  throw new Error("Failed to generate a unique curatorId after 5 attempts");
}

export const CURATOR_ID_RE = /^[a-z0-9]{8}$/;
export const isCuratorId = (s: string): boolean => CURATOR_ID_RE.test(s);
