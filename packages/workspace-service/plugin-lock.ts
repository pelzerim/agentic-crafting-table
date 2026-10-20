import * as z from 'zod/v4';
import type { SqliteStore } from './sqlite-store.ts';

const contributes = z.object({
  itemTypes: z.array(z.string()), accountTypes: z.array(z.string()), runtimeOperations: z.array(z.string()), mcpTools: z.array(z.string()),
  settingsPages: z.array(z.string()), actionContributions: z.record(z.string(), z.array(z.string())), agentGuide: z.array(z.string()), css: z.array(z.string()),
  settingsPresets: z.array(z.string()).default([]),
});
/** One approved build of a package. `integrity` is absent only for a development folder. */
export const pluginReleaseSchema = z.object({
  commit: z.string().regex(/^(?:[0-9a-f]{40}|dev)$/),
  name: z.string(), version: z.string(), apiRange: z.string(),
  contributes,
  code: z.object({ service: z.boolean(), renderer: z.boolean() }),
  integrity: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  approvedAt: z.string(),
});
export const pluginSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('git'), url: z.string().min(1).max(2048), ref: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('folder'), path: z.string().min(1).max(4096) }),
]);
export const installedPluginSchema = z.object({
  id: z.string(),
  source: pluginSourceSchema,
  enabled: z.boolean(),
  /** Removed packages keep their source so they can be reinstalled; their items stay as placeholders. */
  removed: z.boolean().default(false),
  /** Why the loader turned the package off. Cleared when the user enables it again. */
  failure: z.object({ reason: z.string(), at: z.string() }).optional(),
  current: pluginReleaseSchema,
  /** Earlier approved builds kept on disk for rollback, newest first. */
  previous: z.array(pluginReleaseSchema).max(3).default([]),
});
export type PluginRelease = z.infer<typeof pluginReleaseSchema>;
export type PluginSource = z.infer<typeof pluginSourceSchema>;
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

/** Valid lock rows; a row this version cannot read is left untouched and reported. */
export function readPluginLock(store: Pick<SqliteStore, 'pluginLock'>): { plugins: InstalledPlugin[]; unreadable: string[] } {
  const plugins: InstalledPlugin[] = [], unreadable: string[] = [];
  for (const row of store.pluginLock()) {
    const parsed = installedPluginSchema.safeParse(row.body);
    if (parsed.success && parsed.data.id === row.id) plugins.push(parsed.data); else unreadable.push(row.id);
  }
  return { plugins, unreadable };
}
