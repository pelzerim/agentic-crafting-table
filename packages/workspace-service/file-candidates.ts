import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { expandHomePath } from '../core/home-path.ts';
import type { AttachmentCandidate, ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';

/** The item types that take the input as their file, while it is the path of a file on this computer. */
export async function existingFileCandidates(registry: ResourcePluginRegistry, input: string, home = homedir()): Promise<AttachmentCandidate[]> {
  const candidates: AttachmentCandidate[] = [];
  for (const { candidate, path } of registry.matchFile(input)) {
    const file = await stat(expandHomePath(path, home)).catch(() => undefined);
    if (file?.isFile()) candidates.push(candidate);
  }
  return candidates;
}
