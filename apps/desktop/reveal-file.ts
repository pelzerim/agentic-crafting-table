import { isAbsolute, normalize } from 'node:path';
import { expandHomePath } from '../../packages/core/home-path.ts';

/** The one absolute path the file manager is asked to show. A leading `~` stands for the home directory. */
export function filePathToReveal(input: unknown, home: string): string {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\x00-\x1f\x7f]/.test(input)) throw new Error('Invalid file path');
  const path = expandHomePath(input, home);
  if (!isAbsolute(path)) throw new Error('Invalid file path');
  return normalize(path);
}
