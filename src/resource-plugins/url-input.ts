import * as z from 'zod/v4';

/** Discovery is syntax-only: no network read or creation happens while typing. */
export function isResourceUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return input.trim().length <= 8192 && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
export const pluginDiscoverySchema = z.object({ input: z.string().max(8192).optional() });
