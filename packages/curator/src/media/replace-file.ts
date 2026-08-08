// Replacing a file Curator might also be serving (issue #255).
//
// Curator's write-then-swap pattern is to build the new bytes beside the destination and rename on a
// clean finish, so a half-written file never masquerades as a whole one. On Windows that rename
// fails when the destination has an open handle — and Curator itself holds one, because `sendFile`
// streams media with `createReadStream` and the record page plays the attached visualizer on a loop.
// So replacing a clip while looking at it produced:
//
//   EPERM: operation not permitted, rename '…\visualizers\<id>.mp4.tmp-…' -> '…\visualizers\<id>.mp4'
//
// POSIX allows renaming over an open file, which is why Ubuntu CI never saw it.
//
// Measured, not assumed — with an open read stream on the destination:
//
//   renameSync(src, dest)   EPERM        ← the only one that fails
//   copyFileSync(src, dest) OK
//   rmSync(dest)            OK
//   writeFileSync(dest)     OK
//
// libuv opens with share-delete, so unlinking a file someone is reading is legal on Windows too: the
// reader keeps its handle to the now-unlinked inode and the name is free. That is what makes the
// fallback below work, and it is why the family is exactly one operation.
import { renameSync, rmSync } from "node:fs";

/** The Windows codes that mean "something else has this file open", rather than a real fault. */
const LOCKED = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Move `src` onto `dest`, replacing it — the last step of every write-then-swap in Curator.
 *
 * Tries the plain rename first, which is atomic and is what happens on POSIX and on a Windows
 * destination nobody is reading. Only when that fails with a locked-file code does it unlink the
 * destination and rename onto the free name.
 *
 * **The fallback is deliberately not the default.** It opens a window — after the unlink and before
 * the rename — where the destination does not exist, so a crash inside it leaves no visualizer where
 * there used to be an old one. Paying that only when the atomic path is impossible keeps the window
 * off the common case entirely, rather than trading a real guarantee for uniform code.
 */
export function replaceFile(src: string, dest: string): void {
  try {
    renameSync(src, dest);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    // A genuine failure — no such file, no permission on the directory, a cross-device move — is not
    // ours to paper over, and retrying it a different way would only obscure it.
    if (!LOCKED.has(code)) throw err;
  }
  rmSync(dest, { force: true });
  renameSync(src, dest);
}
