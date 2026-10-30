import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_PASTED_IMAGE = 32 * 1024 * 1024;
/** An agent reads a pasted image when the message is sent, which can be long after the paste. */
const KEEP_PASTED_IMAGE = 7 * 24 * 60 * 60 * 1000;

/** Writes one PNG where only this user can read it and clears out old pastes. */
export function savePastedImage(directory: string, png: Uint8Array, now = Date.now()) {
  if (!png.length || png.length > MAX_PASTED_IMAGE) throw new Error('Pasted images must be under 32 MB');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    try { if (now - statSync(file).mtimeMs > KEEP_PASTED_IMAGE) rmSync(file, { force: true }); } catch { /* Another window may have removed it. */ }
  }
  const path = join(directory, `${randomUUID()}.png`);
  writeFileSync(path, png, { mode: 0o600 });
  return path;
}
