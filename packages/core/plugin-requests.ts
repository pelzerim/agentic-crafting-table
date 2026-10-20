import * as z from 'zod/v4';

/** Requests that change installed plugins. Only the person in the app sends them: the desktop
 * window reaches them through its bridge, and no MCP tool forwards them. */
const id = z.string().min(1).max(100);
export const pluginRequestSchemas = {
  'plugins.prepare': z.object({ url: z.string().max(2048), ref: z.string().max(200).optional() }).strict(),
  'plugins.prepareFolder': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'plugins.install': z.object({ id, commit: z.string().regex(/^(?:[0-9a-f]{40}|dev)$/) }).strict(),
  'plugins.enable': z.object({ id, enabled: z.boolean() }).strict(),
  'plugins.rollback': z.object({ id, commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
  'plugins.remove': z.object({ id }).strict(),
} as const;
export type PluginRequestMethod = keyof typeof pluginRequestSchemas;
export const isPluginRequest = (method: string): method is PluginRequestMethod => Object.hasOwn(pluginRequestSchemas, method);
